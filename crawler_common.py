import os
import json
import requests


class ConfigurationError(Exception):
    pass


def resolve_api_base(site_url=None):
    base = site_url or os.environ.get("MW_BASE_URL")
    if not base:
        raise ConfigurationError(
            "MW_BASE_URL not set and site_url not provided. "
            "Set MW_BASE_URL or pass site_url explicitly to connect to a ModelWiki API."
        )
    return base.rstrip("/") + "/api/v1"


def resolve_admin_user():
    value = os.environ.get("MW_ADMIN_USERNAME")
    if not value:
        raise ConfigurationError("MW_ADMIN_USERNAME is not set. Provide an admin username explicitly.")
    return value


def resolve_admin_password():
    value = os.environ.get("MW_ADMIN_PASSWORD")
    if not value:
        raise ConfigurationError("MW_ADMIN_PASSWORD is not set. Provide an admin password explicitly.")
    return value


class JsonlReport:
    def __init__(self, path):
        self.path = path
        self._file = None

    def write(self, event_type, **kwargs):
        if not self._file:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self._file = open(self.path, "a", encoding="utf-8")
        record = {"event": event_type}
        record.update(kwargs)
        self._file.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        self._file.flush()


def submit_review_item(api_base, headers, data):
    resp = requests.post(
        f"{api_base}/admin/review/items",
        json=data,
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()
