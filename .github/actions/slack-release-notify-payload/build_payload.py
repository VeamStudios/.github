#!/usr/bin/env python3
"""Build Slack incoming-webhook JSON for release notifications with optional CHANGELOG excerpt."""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys
from typing import Optional


def normalize_version(version: str) -> str:
    return version.strip().removeprefix("v").removeprefix("V")


def extract_changelog_section(content: str, version: str) -> Optional[str]:
    """Return the body for the release matching `version` (first ## block after the matching heading)."""
    nv = normalize_version(version)
    lines = content.splitlines()
    start: Optional[int] = None
    for i, line in enumerate(lines):
        m = re.match(r"^##\s+v?(.+?)\s*$", line.strip())
        if not m:
            continue
        if normalize_version(m.group(1)) == nv:
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r"^##\s+", lines[j]):
            end = j
            break
    body_lines = lines[start + 1 : end]
    return "\n".join(body_lines).strip()


def markdown_to_slack_mrkdwn(section_md: str) -> str:
    """Light conversion: ### headings -> *bold*, preserve bullets."""
    out: list[str] = []
    for line in section_md.splitlines():
        stripped = line.rstrip()
        if stripped.startswith("### "):
            out.append("*" + stripped[4:].strip() + "*")
        else:
            out.append(stripped)
    return "\n".join(out).strip()


# Slack: context block mrkdwn must be ≤ 2000 characters (smaller / “footer” style in the client).
CONTEXT_MRKDWN_MAX = 2000


def chunk_mrkdwn(text: str, max_len: int) -> list[str]:
    if len(text) <= max_len:
        return [text] if text else []
    chunks: list[str] = []
    rest = text
    while rest:
        if len(rest) <= max_len:
            chunks.append(rest)
            break
        cut = rest.rfind("\n", 0, max_len)
        if cut <= 0:
            cut = max_len
        chunks.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    return chunks


def append_changelog_as_context_blocks(blocks: list[dict], title: str, excerpt: str) -> None:
    """Muted footer-style text (Slack context blocks), not primary section text."""
    combined = f"{title}\n\n{excerpt}".strip()
    for chunk in chunk_mrkdwn(combined, CONTEXT_MRKDWN_MAX):
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": chunk}]})


def build_web_payload() -> dict:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repo = os.environ["GITHUB_REPOSITORY"]
    version = os.environ["VERSION"]
    environment = os.environ["ENVIRONMENT"]
    fallback = os.environ.get(
        "SLACK_FOOTER_FALLBACK",
        "Please inform any customers waiting on fixes in this release.",
    )

    repo_url = f"{server}/{repo}"
    tag_url = f"{repo_url}/releases/tag/{version}"
    header = f"🚀 *<{repo_url}|{repo}>* — <{tag_url}|{version}> deployed to {environment}"

    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": header}}]

    changelog_path = pathlib.Path(os.environ.get("CHANGELOG_PATH", "CHANGELOG.md"))
    excerpt: Optional[str] = None
    if changelog_path.is_file():
        raw = extract_changelog_section(changelog_path.read_text(encoding="utf-8"), version)
        if raw:
            excerpt = markdown_to_slack_mrkdwn(raw)

    if excerpt:
        title = os.environ.get("CHANGELOG_BLOCK_TITLE", "*Latest CHANGELOG*")
        append_changelog_as_context_blocks(blocks, title, excerpt)
    else:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": fallback}]})

    plain = f"{repo} — {version} deployed to {environment}"
    return {"text": plain, "blocks": blocks}


def build_ios_payload() -> dict:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repo = os.environ["GITHUB_REPOSITORY"]
    version = os.environ["VERSION"]
    environment = os.environ["ENVIRONMENT"]
    fallback = os.environ.get(
        "SLACK_FOOTER_FALLBACK",
        "Please inform any customers waiting on fixes in this release.",
    )

    repo_url = f"{server}/{repo}"
    tag_url = f"{repo_url}/releases/tag/{version}"
    header = f"📦 *<{repo_url}|{repo}>* — <{tag_url}|{version}> uploaded to App Store Connect for {environment}"

    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": header}}]

    changelog_path = pathlib.Path(os.environ.get("CHANGELOG_PATH", "CHANGELOG.md"))
    excerpt: Optional[str] = None
    if changelog_path.is_file():
        raw = extract_changelog_section(changelog_path.read_text(encoding="utf-8"), version)
        if raw:
            excerpt = markdown_to_slack_mrkdwn(raw)

    if excerpt:
        title = os.environ.get("CHANGELOG_BLOCK_TITLE", "*Latest CHANGELOG*")
        append_changelog_as_context_blocks(blocks, title, excerpt)

    ctx_lines = [
        (
            f"*Approved Beta:* {os.environ['BETA_VERSION']}  |  "
            f"*Beta Build Number:* {os.environ['BETA_BUILD_NUMBER']}"
        ),
        f"*Beta Commit:* `{os.environ['BETA_COMMIT_SHA']}`",
        (
            f"*Beta Source:* <{os.environ['BETA_RUN_URL']}|"
            f"run #{os.environ['BETA_RUN_ID']}>"
        ),
        (
            f"*Uploaded Cloud:* {os.environ['CLOUD_VERSION']}  |  "
            f"*Cloud Build Number:* {os.environ['CLOUD_BUILD_NUMBER']}"
        ),
        f"*Cloud Commit:* `{os.environ['CLOUD_COMMIT_SHA']}`",
    ]
    if not excerpt:
        ctx_lines.append(fallback)

    elements = [{"type": "mrkdwn", "text": line} for line in ctx_lines]
    blocks.append({"type": "context", "elements": elements})

    plain = f"{repo} — {version} uploaded to App Store Connect for {environment}"
    return {"text": plain, "blocks": blocks}


def main() -> None:
    variant = os.environ.get("VARIANT", "web").lower()
    out_path = pathlib.Path(os.environ.get("OUTPUT_PAYLOAD_PATH", "slack-payload.json"))

    if variant == "ios":
        payload = build_ios_payload()
    else:
        payload = build_web_payload()

    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
