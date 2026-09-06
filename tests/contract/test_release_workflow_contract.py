"""Contracts for continuous Windows release publishing."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_main_push_publishes_versioned_windows_release() -> None:
    workflow = (ROOT / ".github" / "workflows" / "validate.yml").read_text(
        encoding="utf-8"
    )
    package = json.loads(
        (ROOT / "src" / "realtime-translator" / "package.json").read_text(
            encoding="utf-8"
        )
    )

    assert "if: github.event_name == 'push'" in workflow
    assert 'npm version "0.1.${{ github.run_number }}" --no-git-tag-version' in workflow
    assert "needs:" in workflow
    assert "- application" in workflow
    assert "- infrastructure" in workflow
    assert "contents: write" in workflow
    assert "gh release create" in workflow
    assert "release/latest.yml" in workflow
    assert "Validate updater artifacts" in workflow
    assert package["build"]["publish"] == [
        {
            "provider": "github",
            "owner": "matayuuu",
            "repo": "Real-Time-Translation-App",
        }
    ]
    assert package["build"]["nsis"]["artifactName"] == (
        "${name}-setup-${version}.${ext}"
    )
    assert package["build"]["portable"]["artifactName"] == (
        "${name}-portable-${version}.${ext}"
    )
