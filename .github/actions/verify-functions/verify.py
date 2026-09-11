"""Read-only verification of every Firebase-managed production function's source marker."""
import concurrent.futures
import io
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

LIMIT = 100_000_000


def request(url, token='', data=None):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as response:
                body = response.read(LIMIT + 1)
            if len(body) > LIMIT:
                raise ValueError('Source response exceeds verification limit')
            return body
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise ValueError('Provider lookup failed: HTTP ' + str(error.code)) from None
            retry = error.headers.get('Retry-After', '')
            time.sleep(min(30, int(retry)) if retry.isdigit() else 2 ** attempt)
        except urllib.error.URLError:
            if attempt == 3:
                raise ValueError('Provider lookup unavailable; retry verification') from None
            time.sleep(2 ** attempt)


def list_functions(project, token, get=request):
    rows = {}
    for version in ('v1', 'v2'):
        cursor = ''
        seen = set()
        while True:
            query = urllib.parse.urlencode({'pageSize': 1000, 'pageToken': cursor})
            result = json.loads(get(f'https://cloudfunctions.googleapis.com/{version}/projects/{project}/locations/-/functions?{query}', token))
            if result.get('unreachable') or not isinstance(result.get('functions', []), list):
                raise ValueError('Function inventory is incomplete')
            for row in result.get('functions', []):
                if row.get('labels', {}).get('deployment-tool') != 'cli-firebase':
                    continue  # Firebase extensions have their own deployment lifecycle.
                name = row.get('name', '')
                if not re.fullmatch(r'projects/' + re.escape(project) + r'/locations/[^/]+/functions/[^/]+', name):
                    raise ValueError('Malformed function identity')
                # The v2 API can also list Gen 1 functions; inspect each with its native API.
                native = 'v1' if row.get('environment') == 'GEN_1' or 'status' in row else 'v2'
                if name not in rows or native == version:
                    rows[name] = (native, row)
            cursor = result.get('nextPageToken', '')
            if not cursor:
                break
            if cursor in seen:
                raise ValueError('Function inventory pagination did not advance')
            seen.add(cursor)
    if not rows:
        raise ValueError('No Firebase-managed functions found')
    return list(rows.values())


def require_expected(functions, expected):
    if not isinstance(expected, list) or not expected or any(not isinstance(n, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', n) for n in expected) or len(set(expected)) != len(expected):
        raise ValueError('Expected compiled function inventory is invalid')
    deployed = {row['name'].rsplit('/', 1)[1] for _, row in functions}
    missing = set(expected) - deployed
    if missing:
        raise ValueError('Expected functions are absent from production: ' + ', '.join(sorted(missing)))


def inspect_function(item, repository, commit, token, get=request):
    version, row = item
    name = row['name']
    if row.get('state', row.get('status')) != 'ACTIVE':
        raise ValueError('Function is not ACTIVE')
    if version == 'v2' and row.get('serviceConfig', {}).get('allTrafficOnLatestRevision') is not True:
        raise ValueError('Function is not fully serving its latest revision')
    result = json.loads(get(f'https://cloudfunctions.googleapis.com/{version}/{name}:generateDownloadUrl', token, b'{}'))
    url = result.get('downloadUrl', '')
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or not (parsed.hostname == 'storage.googleapis.com' or (parsed.hostname or '').endswith('.storage.googleapis.com')):
        raise ValueError('Source download location is not Google Cloud Storage')
    # Never forward the Google access token to the signed source download URL.
    with zipfile.ZipFile(io.BytesIO(get(url))) as archive:
        if archive.namelist().count('release-info.json') != 1:
            raise ValueError('Deployed source has no unique release-info.json; verify the intended build')
        if archive.getinfo('release-info.json').file_size > 4096:
            raise ValueError('Deployed source marker exceeds size limit')
        marker = json.loads(archive.read('release-info.json'))
    if marker != {'schemaVersion': 1, 'repository': repository, 'commit': commit}:
        raise ValueError('Deployed source marker differs from the intended repository/commit')
    return name


def main():
    project, repository, commit = (os.environ.get(k, '') for k in ('VERIFY_PROJECT', 'GITHUB_REPOSITORY', 'VERIFY_COMMIT'))
    if project not in ('site-audit-pro', 'checklistinspectorpro') or repository != {'site-audit-pro': 'VeamStudios/SiteAuditPro-Backend', 'checklistinspectorpro': 'VeamStudios/ChecklistInspectorPro-Backend'}.get(project) or not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('Expected production project, repository and exact commit are required')
    token = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()
    functions = list_functions(project, token)
    require_expected(functions, json.loads(os.environ.get('VERIFY_EXPECTED_FUNCTIONS', 'null')))
    errors = []
    def check(item):
        try:
            return inspect_function(item, repository, commit, token), ''
        except ValueError as error:
            return item[1]['name'], str(error)
        except Exception:
            return item[1]['name'], 'Source verification failed; provider details withheld'
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for name, error in pool.map(check, functions):
            if error:
                errors.append(name + ': ' + error)
    if errors:
        raise ValueError('Production function verification incomplete:\n' + '\n'.join(errors))
    print(f'Verified all {len(functions)} Firebase-managed function source markers at {commit}.')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
