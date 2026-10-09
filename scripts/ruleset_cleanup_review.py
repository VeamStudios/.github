#!/usr/bin/env python3
"""Review a proposed ruleset cleanup; optionally compare snapshots using GET only.

This tool never changes GitHub settings. Applying the reviewed plan is a separate,
explicitly approved operation. Exit 1 means invalid plan or live configuration drift.
"""
import argparse
import copy
import json
import re
import subprocess
import sys
from pathlib import Path

WRITABLE = ('name', 'target', 'enforcement', 'conditions', 'rules', 'bypass_actors')
REVIEW_ZERO = {
    'required_approving_review_count': 0,
    'dismiss_stale_reviews_on_push': False,
    'require_code_owner_review': False,
    'require_last_push_approval': False,
    'require_extra_approval_for_unattributed_changes': False,
    'required_reviewers': [],
}
CLASSIC_ZERO = {
    'required_approving_review_count': 0,
    'dismiss_stale_reviews': False,
    'require_code_owner_reviews': False,
    'require_last_push_approval': False,
}
LEGACY_IDS = {('ChecklistInspectorPro-Models', 915123), ('SiteAuditPro-Models', 1462432)}
# Only known set-like configuration arrays are unordered. Unknown arrays remain ordered.
SET_ARRAYS = {'rules', 'bypass_actors', 'include', 'exclude', 'allowed_merge_methods',
              'required_status_checks', 'contexts', 'checks', 'required_reviewers',
              'allowed_actors', 'users', 'teams', 'apps'}
COMPUTED = {'id', 'node_id', 'created_at', 'updated_at', 'current_user_can_bypass',
            '_links', 'url', 'source', 'source_type', 'avatar_url', 'gravatar_id',
            'html_url', 'type', 'user_view_type', 'site_admin'}


def canonical(value, key=''):
    """Strip response metadata, preserve rule types and compare known sets in order."""
    if isinstance(value, dict):
        return {k: canonical(v, k) for k, v in value.items()
                if k not in COMPUTED or k == 'type'}
    if isinstance(value, list):
        result = [canonical(v) for v in value]
        if key in SET_ARRAYS:
            result.sort(key=lambda v: json.dumps(v, sort_keys=True))
        return result
    return value


def same(left, right):
    return canonical(left) == canonical(right)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def rules_by_type(ruleset):
    rules = ruleset.get('rules', [])
    out = {rule['type']: rule for rule in rules}
    require(len(out) == len(rules), 'duplicate rule types')
    return out


def assert_no_reviews(params, fields):
    for field, zero in fields.items():
        require(params.get(field, zero) == zero, f'review requirement remains: {field}')


def retained_safety(repository, expected):
    safety = [r for r in expected[repository]['rulesets']
              if r['name'] == 'Default branch · Safety']
    require(len(safety) == 1, 'must retain exactly one Safety ruleset')
    rule = safety[0]
    require(rule['enforcement'] == 'active', 'retained Safety must be active')
    require(rule.get('bypass_actors', []) == [], 'Safety must not gain bypass actors')
    types = rules_by_type(rule)
    require({'deletion', 'non_fast_forward', 'pull_request'} <= types.keys(),
            'retained Safety must protect deletion, force pushes and PRs')
    params = types['pull_request']['parameters']
    assert_no_reviews(params, REVIEW_ZERO)
    require(params.get('allowed_merge_methods') == ['squash'], 'Safety must retain squash only')
    return rule


def validate_operation(op, expected):
    repository, kind = op['repository'], op['kind']
    before, request, after = op['before'], op['request'], op['expected']
    prefix = f'repos/VeamStudios/{repository}/'
    require(op['endpoint'].startswith(prefix), 'endpoint repository mismatch')
    require(repository in expected, 'repository missing expected state')
    if kind in ('delete_team_review', 'delete_disabled_legacy', 'update_ruleset'):
        require(op['endpoint'] == prefix + f"rulesets/{before['id']}", 'ruleset ID mismatch')
        require(before['target'] == 'branch', 'only branch rulesets are in scope')
    if kind.startswith('delete_'):
        require(op['method'] == 'DELETE' and request is None and after is None,
                'deletion must have DELETE method and null request/expected')
        require(all(r['id'] != before['id'] for r in expected[repository]['rulesets']),
                'deleted ruleset remains in expected state')
        safety = retained_safety(repository, expected)
        if kind == 'delete_team_review':
            require(before['name'] == 'Default branch · Team review', 'unexpected Team review name')
            types = rules_by_type(before)
            require(set(types) == {'pull_request'}, 'Team review deletion would remove non-review rules')
            old = types['pull_request']['parameters']
            new = rules_by_type(safety)['pull_request']['parameters']
            require(not old.get('required_review_thread_resolution') or
                    new.get('required_review_thread_resolution'), 'deletion loses resolved-thread protection')
        elif kind == 'delete_disabled_legacy':
            require((repository, before['id']) in LEGACY_IDS, 'legacy ruleset is not explicitly reviewed')
            require(before['enforcement'] == 'disabled', 'legacy deletion must be disabled')
        else:
            raise ValueError('unknown delete operation')
        return
    if kind == 'update_ruleset':
        require(op['method'] == 'PUT', 'ruleset updates must be PUT')
        require(set(request) == set(WRITABLE), 'unexpected writable ruleset fields')
        require(same(request, {k: after[k] for k in WRITABLE}), 'request differs from expected ruleset')
        require(after['id'] == before['id'], 'ruleset identity changed')
        permitted = copy.deepcopy(before)
        permitted['enforcement'] = 'active'
        require(before['name'] in ('Default branch · Safety', 'Default branch · Required checks'),
                'unexpected ruleset update')
        if before['name'] == 'Default branch · Safety':
            params = rules_by_type(permitted)['pull_request']['parameters']
            for field, zero in REVIEW_ZERO.items():
                if field in params:
                    params[field] = zero
            if 'dismissal_restriction' in params:
                params['dismissal_restriction'] = {'enabled': False, 'allowed_actors': []}
        require(same(permitted, after), 'update changes non-review protections or bypasses')
        require(any(r['id'] == after['id'] and same(r, after)
                    for r in expected[repository]['rulesets']), 'expected inventory differs from operation')
        return
    if kind == 'update_classic_reviews':
        require(op['method'] == 'PATCH', 'classic review updates must be PATCH')
        require(re.fullmatch(re.escape(prefix) + r'branches/[^/]+/protection/required_pull_request_reviews',
                             op['endpoint']), 'unexpected classic endpoint')
        allowed = set(CLASSIC_ZERO) | {'dismissal_restrictions'}
        require(set(request) == allowed, 'unexpected classic request fields')
        assert_no_reviews(request, CLASSIC_ZERO)
        require(request['dismissal_restrictions'] == {'users': [], 'teams': [], 'apps': []},
                'classic dismissal restrictions must be cleared')
        permitted = copy.deepcopy(before)
        review = permitted['required_pull_request_reviews']
        review.update(CLASSIC_ZERO)
        if 'dismissal_restrictions' in review:
            review['dismissal_restrictions'].update({'users': [], 'teams': [], 'apps': []})
        require(same(permitted, after), 'classic update changes non-review protections')
        return
    raise ValueError(f'unknown operation kind: {kind}')


def validate_manifest(manifest):
    require(manifest.get('schema_version') == 1, 'unsupported schema version')
    expected = {r['repository']: r for r in manifest['expected_repositories']}
    require(len(expected) == len(manifest['expected_repositories']), 'duplicate expected repositories')
    require(set(expected) == set(manifest['scope']), 'scope differs from expected repositories')
    require('StaffManagerPro-Backend' not in expected, 'inactive repository must remain excluded')
    endpoints = set()
    for op in manifest['operations']:
        require(op['endpoint'] not in endpoints, 'duplicate operation endpoint')
        endpoints.add(op['endpoint'])
        try:
            validate_operation(op, expected)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{op.get('repository')}: {op.get('kind')}: {exc}") from exc
    for item in manifest.get('unchanged', []):
        require(item['endpoint'] not in endpoints, 'unchanged endpoint is also mutated')
        before = item['before']
        repository = item['repository']
        if '/rulesets/' in item['endpoint']:
            require(any(r['id'] == before['id'] and same(before, r)
                        for r in expected[repository]['rulesets']),
                    f'{repository}: unchanged ruleset altered in expected inventory')
        else:
            options = [expected[repository].get('classic_default_branch')]
            options += list(expected[repository].get('classic_nondefault_rest', {}).values())
            require(any(same(before, candidate) for candidate in options),
                    f'{repository}: unchanged classic protection altered')
    for repository in expected:
        retained_safety(repository, expected)
    return len(manifest['operations'])


def get_configuration(endpoint):
    """The sole network call in this program; GET is explicit and fixed."""
    result = subprocess.run(['gh', 'api', '--method', 'GET', endpoint],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def check_live(manifest, getter=get_configuration):
    errors = []
    items = manifest['operations'] + manifest.get('unchanged', [])
    for item in items:
        endpoint = item['endpoint']
        if item.get('kind') == 'update_classic_reviews':
            endpoint = endpoint.removesuffix('/required_pull_request_reviews')
        try:
            actual = getter(endpoint)
            if not same(actual, item['before']):
                errors.append(f'{endpoint}: configuration changed since snapshot')
        except (subprocess.CalledProcessError, json.JSONDecodeError, OSError) as exc:
            errors.append(f'{endpoint}: GET failed ({type(exc).__name__})')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--check-live', action='store_true', help='GET current settings and reject drift')
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        count = validate_manifest(manifest)
        errors = check_live(manifest) if args.check_live else []
        if errors:
            print('\n'.join(errors), file=sys.stderr)
            return 1
        print(f'Valid proposed cleanup: {count} operations. No settings changed.' +
              (' Live snapshots match.' if args.check_live else ' Live settings not checked.'))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f'Invalid cleanup plan: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
