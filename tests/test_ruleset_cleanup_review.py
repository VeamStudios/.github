"""Regression checks for unsafe plan edits and GET-only drift detection."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'review', Path(__file__).resolve().parents[1] / 'scripts' / 'ruleset_cleanup_review.py')
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)


def safety():
    return {'id': 1, 'name': 'Default branch · Safety', 'target': 'branch',
            'enforcement': 'active', 'conditions': {'ref_name': {'include': ['~DEFAULT_BRANCH'], 'exclude': []}},
            'bypass_actors': [], 'rules': [
                {'type': 'deletion'}, {'type': 'non_fast_forward'},
                {'type': 'pull_request', 'parameters': dict(
                    review.REVIEW_ZERO, required_review_thread_resolution=True, allowed_merge_methods=['squash'])}]}


def fixture():
    safe = safety()
    team = copy.deepcopy(safe)
    team.update(id=2, name='Default branch · Team review')
    team['rules'] = [copy.deepcopy(safe['rules'][2])]
    team['rules'][0]['parameters']['required_approving_review_count'] = 1
    return {'schema_version': 1, 'scope': ['Example'], 'operations': [{
        'repository': 'Example', 'kind': 'delete_team_review', 'method': 'DELETE',
        'endpoint': 'repos/VeamStudios/Example/rulesets/2', 'before': team,
        'request': None, 'expected': None}],
        'expected_repositories': [{'repository': 'Example', 'rulesets': [safe]}],
        'unchanged': [{'repository': 'Example', 'endpoint': 'repos/VeamStudios/Example/rulesets/1',
                       'before': copy.deepcopy(safe)}]}


def update_fixture():
    m = fixture()
    before = copy.deepcopy(safety())
    before['enforcement'] = 'disabled'
    before['rules'][2]['parameters']['require_extra_approval_for_unattributed_changes'] = True
    after = safety()
    m['unchanged'] = []
    m['operations'].append({'repository': 'Example', 'kind': 'update_ruleset',
                            'method': 'PUT', 'endpoint': 'repos/VeamStudios/Example/rulesets/1',
                            'before': before, 'expected': after,
                            'request': {k: copy.deepcopy(after[k]) for k in review.WRITABLE}})
    return m


class PlanTests(unittest.TestCase):
    def test_valid_plan(self):
        self.assertEqual(review.validate_manifest(fixture()), 1)
        self.assertEqual(review.validate_manifest(update_fixture()), 2)

    def test_safety_cannot_be_deleted_by_renaming_kind(self):
        m = fixture()
        m['operations'][0]['before']['name'] = 'Default branch · Safety'
        with self.assertRaisesRegex(ValueError, 'unexpected Team review'):
            review.validate_manifest(m)

    def test_team_layer_cannot_hide_required_checks(self):
        m = fixture()
        m['operations'][0]['before']['rules'].append({'type': 'required_status_checks'})
        with self.assertRaisesRegex(ValueError, 'non-review rules'):
            review.validate_manifest(m)

    def test_safety_activation_cannot_add_bypass(self):
        m = update_fixture()
        op = m['operations'][1]
        actor = {'actor_id': 999, 'actor_type': 'Team', 'bypass_mode': 'always'}
        op['expected']['bypass_actors'] = op['request']['bypass_actors'] = [actor]
        with self.assertRaises(ValueError):
            review.validate_manifest(m)

    def test_update_cannot_drop_thread_resolution(self):
        m = update_fixture()
        op = m['operations'][1]
        for obj in (op['expected'], op['request']):
            obj['rules'][2]['parameters']['required_review_thread_resolution'] = False
        with self.assertRaisesRegex(ValueError, 'non-review protections'):
            review.validate_manifest(m)

    def test_live_reordering_and_timestamp_is_not_drift(self):
        m = fixture()
        responses = {item['endpoint']: copy.deepcopy(item['before'])
                     for item in m['operations'] + m['unchanged']}
        responses[m['unchanged'][0]['endpoint']]['rules'].reverse()
        for obj in responses.values():
            obj['updated_at'] = 'tomorrow'
        self.assertEqual(review.check_live(m, responses.__getitem__), [])

    def test_live_ci_context_drift_is_detected(self):
        m = fixture()
        m['unchanged'][0]['before']['rules'].append({'type': 'required_status_checks', 'parameters': {
            'required_status_checks': [{'context': 'Build', 'integration_id': 15368}]}})
        def getter(endpoint):
            item = next(i for i in m['operations'] + m['unchanged'] if i['endpoint'] == endpoint)
            obj = copy.deepcopy(item['before'])
            if endpoint.endswith('/1'):
                obj['rules'][-1]['parameters']['required_status_checks'][0]['context'] = 'Different'
            return obj
        self.assertEqual(len(review.check_live(m, getter)), 1)

    def test_get_configuration_fixes_http_method_and_uses_argument_list(self):
        with patch.object(review.subprocess, 'run') as run:
            run.return_value.stdout = '{}'
            review.get_configuration('repos/VeamStudios/Example/rulesets/1')
            self.assertEqual(run.call_args.args[0], [
                'gh', 'api', '--method', 'GET', 'repos/VeamStudios/Example/rulesets/1'])
            self.assertTrue(run.call_args.kwargs['check'])

    def test_classic_ci_must_not_change(self):
        m = fixture()
        before = {'required_pull_request_reviews': dict(review.CLASSIC_ZERO, dismiss_stale_reviews=True),
                  'required_status_checks': {'strict': True, 'contexts': ['check'], 'checks': []},
                  'allow_force_pushes': {'enabled': False}}
        after = copy.deepcopy(before)
        after['required_pull_request_reviews'].update(review.CLASSIC_ZERO)
        request = dict(review.CLASSIC_ZERO, dismissal_restrictions={'users': [], 'teams': [], 'apps': []})
        op = {'repository': 'Example', 'kind': 'update_classic_reviews', 'method': 'PATCH',
              'endpoint': 'repos/VeamStudios/Example/branches/main/protection/required_pull_request_reviews',
              'before': before, 'request': request, 'expected': after}
        m['operations'].append(op)
        self.assertEqual(review.validate_manifest(m), 2)
        after['required_status_checks']['contexts'] = []
        with self.assertRaisesRegex(ValueError, 'non-review protections'):
            review.validate_manifest(m)

    def test_classic_live_reads_full_protection_endpoint(self):
        m = fixture()
        m['operations'] = [{'kind': 'update_classic_reviews', 'endpoint':
                            'repos/VeamStudios/Example/branches/main/protection/required_pull_request_reviews',
                            'before': {}}]
        m['unchanged'] = []
        endpoints = []
        self.assertEqual(review.check_live(m, lambda e: endpoints.append(e) or {}), [])
        self.assertEqual(endpoints, ['repos/VeamStudios/Example/branches/main/protection'])

    def test_unchanged_bypass_cannot_change_in_inventory(self):
        m = fixture()
        work = {'id': 3, 'name': 'Work Item', 'rules': [], 'bypass_actors': []}
        m['unchanged'].append({'repository': 'Example', 'endpoint':
                              'repos/VeamStudios/Example/rulesets/3', 'before': copy.deepcopy(work)})
        m['expected_repositories'][0]['rulesets'].append(work)
        work['bypass_actors'] = [{'actor_id': 9}]
        with self.assertRaisesRegex(ValueError, 'unchanged ruleset altered'):
            review.validate_manifest(m)

    def test_unreviewed_legacy_id_is_rejected(self):
        m = fixture()
        op = m['operations'][0]
        op['kind'] = 'delete_disabled_legacy'
        op['before']['enforcement'] = 'disabled'
        with self.assertRaisesRegex(ValueError, 'not explicitly reviewed'):
            review.validate_manifest(m)


if __name__ == '__main__':
    unittest.main()
