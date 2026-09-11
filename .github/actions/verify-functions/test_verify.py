import io
import json
import unittest
import zipfile
from verify import inspect_function, list_functions, require_expected

REPO = 'VeamStudios/ChecklistInspectorPro-Backend'
COMMIT = 'a' * 40
NAME = 'projects/checklistinspectorpro/locations/europe-west1/functions/example'


def archive(marker):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        if marker is not None:
            z.writestr('release-info.json', json.dumps(marker))
    return buf.getvalue()


class Verification(unittest.TestCase):
    def run_check(self, marker=None, version='v2', state='ACTIVE', traffic=True):
        row = {'name': NAME, 'state': state, 'serviceConfig': {'allTrafficOnLatestRevision': traffic}}
        content = archive(marker)
        def get(url, token='', data=None):
            if ':generateDownloadUrl' in url:
                self.assertEqual(token, 'secret')
                return json.dumps({'downloadUrl': 'https://storage.googleapis.com/source'}).encode()
            self.assertEqual(token, '')
            return content
        return inspect_function((version, row), REPO, COMMIT, 'secret', get)

    def test_new_function_missing_from_provider(self):
        with self.assertRaisesRegex(ValueError, 'absent.*new-function'):
            require_expected([('v1', {'name': NAME})], ['example', 'new-function'])

    def test_expected_inventory_present(self):
        require_expected([('v1', {'name': NAME})], ['example'])

    def test_matching_build(self):
        self.assertEqual(self.run_check({'schemaVersion': 1, 'repository': REPO, 'commit': COMMIT}), NAME)

    def test_gen_one(self):
        self.assertEqual(self.run_check({'schemaVersion': 1, 'repository': REPO, 'commit': COMMIT}, version='v1', traffic=False), NAME)

    def test_old_build(self):
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.run_check({'schemaVersion': 1, 'repository': REPO, 'commit': 'b' * 40})

    def test_missing_marker(self):
        with self.assertRaisesRegex(ValueError, 'no unique'):
            self.run_check()

    def test_partial_traffic(self):
        with self.assertRaisesRegex(ValueError, 'fully serving'):
            self.run_check(traffic=False)

    def test_inactive(self):
        with self.assertRaisesRegex(ValueError, 'not ACTIVE'):
            self.run_check(state='DEPLOYING')

    def test_empty_inventory(self):
        with self.assertRaisesRegex(ValueError, 'No Firebase'):
            list_functions('checklistinspectorpro', '', lambda *a: b'{}')

    def test_unreachable_region(self):
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            list_functions('checklistinspectorpro', '', lambda *a: b'{"unreachable":["europe-west1"]}')

    def test_pagination_extensions_and_native_generation(self):
        def get(url, *args):
            if '/v2/' in url:
                return json.dumps({'functions': [{'name': NAME, 'environment': 'GEN_1', 'labels': {'deployment-tool': 'cli-firebase'}}]}).encode()
            if 'pageToken=second' in url:
                return b'{"functions":[{"labels":{"deployment-tool":"firebase-extensions"}}]}'
            return json.dumps({'functions': [{'name': NAME, 'status': 'ACTIVE', 'labels': {'deployment-tool': 'cli-firebase'}}], 'nextPageToken': 'second'}).encode()
        result = list_functions('checklistinspectorpro', '', get)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0][0], 'v1')
        self.assertEqual(result[0][1]['status'], 'ACTIVE')

    def test_provider_error_not_suppressed(self):
        def get(*args):
            raise ValueError('Provider lookup failed: HTTP 403')
        with self.assertRaisesRegex(ValueError, '403'):
            list_functions('checklistinspectorpro', '', get)


if __name__ == '__main__':
    unittest.main()
