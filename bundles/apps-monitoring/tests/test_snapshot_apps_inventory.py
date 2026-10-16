import sys, types
from pathlib import Path
from unittest import mock
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import snapshot_apps_inventory as m
from databricks.sdk.errors import NotFound, PermissionDenied, InternalError
from pyspark.sql.types import _make_type_verifier

def app(name, scopes=None, creator="a@x.com"):
    return types.SimpleNamespace(name=name, id=f"id-{name}", creator=creator, user_api_scopes=scopes,
        app_status=types.SimpleNamespace(state="RUNNING", message="ok"), compute_status=None,
        active_deployment=None, pending_deployment=None, create_time="2026-01-01T00:00:00Z", update_time=None,
        description=None, service_principal_id=1, service_principal_name="sp", service_principal_client_id="c",
        oauth2_app_client_id="o", url="u")

def run_main(get_side_effect, listed, users=None, sps=None, argv=("--catalog", "demos", "--schema", "admin_insights")):
    w = mock.MagicMock()
    w.get_workspace_id.return_value = 1
    w.apps.list.return_value = listed
    w.apps.get.side_effect = get_side_effect
    w.users.list.return_value = users if users is not None else [types.SimpleNamespace(active=True)]
    w.service_principals.list.return_value = sps or []
    spark = mock.MagicMock()
    with mock.patch.object(m, "WorkspaceClient", return_value=w), \
         mock.patch.object(m.SparkSession, "builder") as b, \
         mock.patch.object(sys, "argv", ["x", *argv]):
        b.getOrCreate.return_value = spark
        m.main()
    return spark

def run(*args, **kwargs):
    spark = run_main(*args, **kwargs)
    rows = spark.createDataFrame.call_args[0][0]
    verify = _make_type_verifier(m.SCHEMA)
    for r in rows: verify(r)
    idx = {f.name: i for i, f in enumerate(m.SCHEMA.fields)}
    return [{k: r[i] for k, i in idx.items()} for r in rows]

def test_notfound_skipped_and_other_error_kept_incomplete():
    listed = [app("a"), app("gone"), app("flaky")]
    def get(name):
        if name == "gone": raise NotFound("x")
        if name == "flaky": raise InternalError("boom")
        return app(name, scopes=["sql"])
    rows = run(get, listed)
    assert [r["app_name"] for r in rows] == ["a", "flaky"]
    assert rows[0]["metadata_incomplete"] is False and rows[0]["user_api_scopes"] == ["sql"]
    assert rows[1]["metadata_incomplete"] is True and rows[1]["user_api_scopes"] is None and rows[1]["app_state"] is None

def test_complete_app_without_scopes_is_empty_not_null():
    rows = run(lambda name: app(name), [app("a")])
    assert rows[0]["user_api_scopes"] == []

def test_auth_error_fails():
    with pytest.raises(PermissionDenied):
        run(PermissionDenied("no"), [app("a")])

def test_all_gets_failing_is_workspace_wide():
    with pytest.raises(RuntimeError):
        run(InternalError("boom"), [app("a"), app("b")])

def test_notfound_plus_error_with_no_successful_gets_aborts():
    def get(name):
        if name == "gone": raise NotFound("x")
        raise InternalError("boom")
    with pytest.raises(RuntimeError):
        run(get, [app("gone"), app("flaky")])

def test_zero_listed_apps_writes_empty_snapshot():
    assert run(lambda name: app(name), []) == []

def test_only_notfound_writes_empty_snapshot():
    assert run(NotFound("x"), [app("a"), app("b")]) == []

def test_unknown_creator_is_null_not_inactive():
    rows = run(lambda name: app(name, creator="someone"), [app("a", creator="someone")], users=[])
    assert rows[0]["creator_type"] == "unknown" and rows[0]["creator_active"] is None

def test_missing_email_creator_is_inactive_user():
    rows = run(lambda name: app(name), [app("a")], users=[])
    assert rows[0]["creator_type"] == "user" and rows[0]["creator_active"] is False

@pytest.mark.parametrize("bad", ["demos`; DROP", "a.b", "", "x-y", "demos\n"])
def test_bad_identifier_fails_fast(bad):
    with pytest.raises(ValueError):
        run(lambda name: app(name), [app("a")], argv=("--catalog", bad, "--schema", "s"))

@pytest.mark.parametrize("good", ["", "monitor_", "A1_b"])
def test_valid_prefix_accepted(good):
    assert m.validate_name_prefix(good) == good

@pytest.mark.parametrize("bad", ["monitor-", "a.b", "x`", "m\n", " ", None])
def test_bad_prefix_fails_fast(bad):
    with pytest.raises(ValueError):
        m.validate_name_prefix(bad)

def test_bad_prefix_fails_before_api_calls():
    argv = ["x", "--catalog", "demos", "--schema", "s", "--name-prefix", "x-"]
    with mock.patch.object(m, "WorkspaceClient") as wc, mock.patch.object(sys, "argv", argv), \
         pytest.raises(ValueError):
        m.main()
    wc.assert_not_called()

@pytest.mark.parametrize("prefix, expected", [
    ("monitor_", "`demos`.`admin_insights`.monitor_apps_inventory_snapshot"),
    ("", "`demos`.`admin_insights`.apps_inventory_snapshot"),
])
def test_snapshot_table_name_uses_prefix(prefix, expected):
    assert m.snapshot_table_name("demos", "admin_insights", prefix) == expected
    spark = run_main(lambda name: app(name), [app("a")],
                     argv=("--catalog", "demos", "--schema", "admin_insights", "--name-prefix", prefix))
    spark.createDataFrame.return_value.write.mode.return_value.option.return_value.saveAsTable.assert_called_once_with(expected)

def test_prefix_defaults_to_empty():
    spark = run_main(lambda name: app(name), [app("a")])
    spark.createDataFrame.return_value.write.mode.return_value.option.return_value.saveAsTable.assert_called_once_with(
        "`demos`.`admin_insights`.apps_inventory_snapshot")


FLOOR_ERROR = r"databricks-sdk>=0\.49\.0.*environment_version"


@pytest.mark.parametrize("version", ["0.49.0", "0.49.0.post1", "0.49.post2", "0.49.0.post1.dev1",
                                     "0.49.0+local", "0.67.0", "0.122.0",
                                     "1.0.0", "1.0.0rc1"])
def test_sdk_version_at_floor_or_newer_passes(version):
    assert m.check_sdk_version(version) == version


@pytest.mark.parametrize("version", ["0.40.0", "0.48.9", "0.48.9.post1", "0.49.0.dev1", "0.49.0rc1", "0.49.0a1",
                                     "0.49.0b2", "0.49.0.rc1", "0.49.0-beta.1"])
def test_sdk_version_below_floor_fails_naming_environment_version(version):
    with pytest.raises(RuntimeError, match=FLOOR_ERROR):
        m.check_sdk_version(version)


@pytest.mark.parametrize("version", ["", "unknown", "abc.def", "0.49.0garbage", None, 49])
def test_unparseable_sdk_version_fails_with_diagnostic(version):
    with mock.patch.object(m, "installed_sdk_version", return_value=version), \
         pytest.raises(RuntimeError, match=FLOOR_ERROR):
        m.check_sdk_version()


def test_installed_sdk_version_prefers_distribution_metadata():
    with mock.patch.object(m.importlib.metadata, "version", return_value="0.67.0") as v:
        assert m.check_sdk_version() == "0.67.0"
    v.assert_called_once_with("databricks-sdk")


def test_installed_sdk_version_falls_back_to_module_version():
    from databricks.sdk.version import __version__
    with mock.patch.object(m.importlib.metadata, "version", side_effect=m.importlib.metadata.PackageNotFoundError):
        assert m.installed_sdk_version() == __version__


def test_unavailable_sdk_version_fails_with_diagnostic():
    with mock.patch.object(m.importlib.metadata, "version", side_effect=m.importlib.metadata.PackageNotFoundError), \
         mock.patch.dict(sys.modules, {"databricks.sdk.version": None}):
        assert m.installed_sdk_version() is None
        with pytest.raises(RuntimeError,
                           match=r"databricks-sdk>=0\.49\.0 is required, found unknown\..*environment_version"):
            m.check_sdk_version()


def test_main_checks_installed_sdk_version_first():
    with mock.patch.object(m, "installed_sdk_version", return_value="0.40.0"), \
         pytest.raises(RuntimeError, match="0.40.0"):
        run(lambda name: app(name), [app("a")])
