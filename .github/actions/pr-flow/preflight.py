#!/usr/bin/env python3
"""Read-only activation evidence; never changes rules, PRs, refs or access."""
import argparse
import base64
import datetime
import json
import pathlib
import subprocess
import urllib.parse


def api(path):
    r = subprocess.run(['gh', 'api', path], capture_output=True, text=True)
    return (json.loads(r.stdout), None) if r.returncode == 0 else (None, r.stderr.strip())


def pages(path):
    rows = []
    for page in range(1, 10000):
        data, error = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        if error:
            return None, error
        rows.extend(data)
        if len(data) < 100:
            return rows, None
    raise RuntimeError('Pagination did not terminate')


def inspect(repo, profiles):
    prefix = f'repos/VeamStudios/{repo}'
    result = {'repository': repo, 'blockers': [], 'warnings': []}
    meta, error = api(prefix)
    if error:
        result['blockers'].append(error)
        return result
    branch = urllib.parse.quote(meta['default_branch'], safe='')
    result.update(default_branch=meta['default_branch'], allow_auto_merge=meta.get('allow_auto_merge'))
    profile = profiles.get(repo)
    if not profile:
        result['blockers'].append('No reviewed CI profile')
    else:
        result['blockers'] += [p['missing'] for g in ('Build', 'Run', 'Verify') for p in profile[g] if 'missing' in p]
    caller, error = api(prefix + '/contents/.github/workflows/pr-flow.yml?ref=' + branch)
    if error:
        result['blockers'].append('Caller not yet on the default branch')
    errors, error = api(prefix + '/codeowners/errors?ref=' + branch)
    if error:
        result['blockers'].append('CODEOWNERS validation unknown: ' + error)
    elif errors.get('errors'):
        result['codeowner_errors'] = errors['errors']
        result['blockers'].append('Invalid owners: confirm the real replacement reviewers')
    owners = None
    for path in ('.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'):
        data, error = api(prefix + '/contents/' + path + '?ref=' + branch)
        if data and 'content' in data:
            owners = base64.b64decode(data['content']).decode()
            break
    if owners is None:
        result['blockers'].append('No CODEOWNERS file')
    pulls, error = pages(prefix + '/pulls?state=open')
    if error:
        result['blockers'].append('PR author eligibility unknown: ' + error)
    else:
        result['harry_authored_prs'] = [p['html_url'] for p in pulls if p['user']['login'] == 'harrygt']
        tokens = {t for line in (owners or '').splitlines() for t in line.split('#')[0].split()[1:]}
        if tokens == {'@harrygt'} and result['harry_authored_prs']:
            result['blockers'].append('Harry-only ownership blocks Harry-authored PRs: assign an independent owner, never bypass')
    result['active_rules'], error = pages(prefix + '/rules/branches/' + branch)
    if error:
        result['blockers'].append('Active rules unknown: ' + error)
    result['classic_protection'], error = api(prefix + '/branches/' + branch + '/protection')
    if error:
        result['warnings'].append('Classic protection unknown/unavailable: ' + error)
    result['warnings'].append('Live success/failure/rerun checks, owner approval and downstream merge/deploy behavior must still be proved before activation')
    result['configuration_candidate'] = not result['blockers']
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repos', nargs='+', help='VeamStudios repository names')
    args = parser.parse_args()
    profiles = json.loads(pathlib.Path(__file__).with_name('profiles.json').read_text())
    print(json.dumps({'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'repositories': [inspect(repo, profiles) for repo in args.repos]}, indent=2))
