"""Contract tests for crawler_common.py — mock-based, no real network/Redis."""

import os
import json
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from crawler_common import (
    JsonlReport,
    resolve_api_base,
    resolve_admin_user,
    resolve_admin_password,
    submit_review_item,
    ConfigurationError,
)


class TestResolveApiBase(unittest.TestCase):
    def setUp(self):
        self._orig_env = os.environ.copy()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_raises_without_base_url(self):
        os.environ.pop("MW_BASE_URL", None)
        with self.assertRaises(ConfigurationError):
            resolve_api_base()

    def test_uses_env_var(self):
        os.environ["MW_BASE_URL"] = "https://example.com"
        self.assertEqual(resolve_api_base(), "https://example.com/api/v1")

    def test_site_url_preferred_over_env(self):
        os.environ["MW_BASE_URL"] = "https://env.com"
        self.assertEqual(resolve_api_base("https://arg.com"), "https://arg.com/api/v1")

    def test_trailing_slash_stripped(self):
        self.assertEqual(resolve_api_base("https://x.com/"), "https://x.com/api/v1")


class TestResolveAdminUser(unittest.TestCase):
    def setUp(self):
        self._orig_env = os.environ.copy()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_raises_without_username(self):
        os.environ.pop("MW_ADMIN_USERNAME", None)
        with self.assertRaises(ConfigurationError):
            resolve_admin_user()

    def test_uses_env_var(self):
        os.environ["MW_ADMIN_USERNAME"] = "testuser"
        self.assertEqual(resolve_admin_user(), "testuser")


class TestResolveAdminPassword(unittest.TestCase):
    def setUp(self):
        self._orig_env = os.environ.copy()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_raises_without_password(self):
        os.environ.pop("MW_ADMIN_PASSWORD", None)
        with self.assertRaises(ConfigurationError):
            resolve_admin_password()

    def test_uses_env_var(self):
        os.environ["MW_ADMIN_PASSWORD"] = "secret123"
        self.assertEqual(resolve_admin_password(), "secret123")


class TestJsonlReport(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.report_path = os.path.join(self.tmpdir, "report.jsonl")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_write_creates_file(self):
        report = JsonlReport(self.report_path)
        report.write("test_event", key1="val1", key2=2)
        self.assertTrue(os.path.exists(self.report_path))

    def test_write_appends_jsonl(self):
        report = JsonlReport(self.report_path)
        report.write("ev1", a=1)
        report.write("ev2", b=2)
        with open(self.report_path) as f:
            lines = f.readlines()
        self.assertEqual(len(lines), 2)

    def test_write_content_format(self):
        report = JsonlReport(self.report_path)
        report.write("my_event", id=42, name="test")
        with open(self.report_path) as f:
            record = json.loads(f.readline())
        self.assertEqual(record["event"], "my_event")
        self.assertEqual(record["id"], 42)
        self.assertEqual(record["name"], "test")

    def test_write_handles_non_string_values(self):
        report = JsonlReport(self.report_path)
        report.write("ev", items=[1, 2, 3], ok=True)
        with open(self.report_path) as f:
            record = json.loads(f.readline())
        self.assertEqual(record["items"], [1, 2, 3])
        self.assertEqual(record["ok"], True)

    def test_path_property(self):
        report = JsonlReport(self.report_path)
        self.assertEqual(report.path, self.report_path)


class TestSubmitReviewItem(unittest.TestCase):
    @patch("crawler_common.requests.post")
    def test_posts_to_correct_url(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"success": True}
        mock_post.return_value = mock_response

        submit_review_item("https://example.com/api/v1", {"Authorization": "Bearer x"}, {"type": "test"})

        mock_post.assert_called_once_with(
            "https://example.com/api/v1/admin/review/items",
            json={"type": "test"},
            headers={"Authorization": "Bearer x"},
            timeout=30,
        )

    @patch("crawler_common.requests.post")
    def test_raises_on_non_2xx(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.raise_for_status.side_effect = Exception("400 Client Error")
        mock_post.return_value = mock_response

        with self.assertRaises(Exception):
            submit_review_item("https://example.com/api/v1", {}, {})

    @patch("crawler_common.requests.post")
    def test_returns_json(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"success": True, "data": {"id": 1}}
        mock_post.return_value = mock_response

        result = submit_review_item("https://x.com/api/v1", {}, {})
        self.assertEqual(result, {"success": True, "data": {"id": 1}})

    @patch("crawler_common.requests.post")
    def test_has_timeout(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {}
        mock_post.return_value = mock_response

        submit_review_item("https://x.com/api/v1", {}, {})
        _, kwargs = mock_post.call_args
        self.assertEqual(kwargs["timeout"], 30)


if __name__ == "__main__":
    unittest.main()
