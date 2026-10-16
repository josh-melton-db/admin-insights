"""Result-semantics tests for the dashboard's ds_apps dataset.

Runs the real ds_apps SQL on a SQL warehouse with every table swapped for a
fixture CTE, so Databricks SQL itself evaluates the flags. Skipped unless
APPS_MONITORING_PROFILE (CLI profile) and APPS_MONITORING_WAREHOUSE_ID are set:
  APPS_MONITORING_PROFILE=<profile> APPS_MONITORING_WAREHOUSE_ID=<id> \\
    python3 -m pytest -q tests/test_ds_apps_live.py
Fixture identifiers are made up; nothing is read from real tables.
"""
import json
import os
from pathlib import Path

import pytest
import yaml

BUNDLE = Path(__file__).resolve().parents[1]
PROFILE = os.environ.get("APPS_MONITORING_PROFILE")
WAREHOUSE = os.environ.get("APPS_MONITORING_WAREHOUSE_ID")

pytestmark = pytest.mark.skipif(
    not (PROFILE and WAREHOUSE), reason="set APPS_MONITORING_PROFILE and APPS_MONITORING_WAREHOUSE_ID"
)

USAGE_DAYS = 30


def sp(n):
    return f"00000000-0000-0000-0000-{n:012d}"


# app_name -> (service principal client id, compute_state, stale, creator_active, user_api_scopes)
APPS = {
    "fx_login_only": (sp(1), "ACTIVE", False, True, "array('sql')"),
    "fx_obo": (sp(2), "ACTIVE", False, True, "array('sql')"),
    # Every informational flag set, but its SP did work.
    "fx_sp": (sp(3), "STOPPED", True, False, "CAST(array() AS ARRAY<STRING>)"),
    "fx_sp_obo": (sp(4), "ACTIVE", False, True, "array('sql')"),
    "fx_idle": (sp(5), "ACTIVE", False, True, "array('sql')"),
    # Only its own SP shows up in the OBO and login MVs.
    "fx_own_sp": (sp(6), "ACTIVE", False, True, "array('sql')"),
    # All activity is older than the usage window.
    "fx_old": (sp(7), "ACTIVE", False, True, "array('sql')"),
}


def _snapshot():
    rows = []
    for name, (sp_id, compute, stale, active, scopes) in APPS.items():
        changed = "current_timestamp() - INTERVAL 200 DAYS" if stale else "current_timestamp() - INTERVAL 1 DAYS"
        rows.append(
            f"SELECT current_timestamp() AS snapshot_time, '1' AS workspace_id, '{name}' AS app_name, "
            f"'id_{name}' AS app_id, 'creator_{name}@example.com' AS creator, 'user' AS creator_type, "
            f"{str(active).lower()} AS creator_active, false AS metadata_incomplete, 'RUNNING' AS app_state, "
            f"'{compute}' AS compute_state, 'dep_{name}' AS active_deployment_id, "
            f"{changed} AS active_deployment_create_time, {changed} AS active_deployment_update_time, "
            f"{changed} AS create_time, {changed} AS update_time, '{sp_id}' AS service_principal_client_id, "
            f"'client_{name}' AS oauth2_app_client_id, 'https://example.invalid/{name}' AS url, "
            f"{scopes} AS user_api_scopes"
        )
    return " UNION ALL ".join(rows)


def _rows(cols, rows):
    return " UNION ALL ".join(
        "SELECT " + ", ".join(f"{v} AS {c}" for c, v in zip(cols, r)) for r in rows
    )


def _obo():
    cols = ("activity_date", "oauth2_app_client_id", "user_email", "event_count")
    today = "current_date()"
    return _rows(cols, [
        (today, "'client_fx_obo'", "'user1@example.com'", 3),
        (today, "'client_fx_sp_obo'", "'user2@example.com'", 2),
        (today, "'client_fx_own_sp'", f"'{sp(6)}'", 9),
        ("date_sub(current_date(), 40)", "'client_fx_old'", "'user3@example.com'", 1),
    ])


def _access():
    cols = ("activity_date", "oauth2_app_client_id", "user_email", "signal", "event_count")
    today = "current_date()"
    return _rows(cols, [
        (today, "'client_fx_login_only'", "'user1@example.com'", "'login'", 1),
        (today, "'client_fx_own_sp'", f"'{sp(6)}'", "'login'", 1),
        (today, "CAST(NULL AS STRING)", f"'{sp(3)}'", "'sp_activity'", 5),
        (today, "CAST(NULL AS STRING)", f"'{sp(4)}'", "'sp_activity'", 5),
        # Another app's SP never counts for fx_idle.
        (today, "CAST(NULL AS STRING)", f"'{sp(99)}'", "'sp_activity'", 5),
        ("date_sub(current_date(), 40)", "CAST(NULL AS STRING)", f"'{sp(7)}'", "'sp_activity'", 5),
        ("date_sub(current_date(), 40)", "'client_fx_old'", "'user3@example.com'", "'login'", 1),
    ])


def _billing():
    return " UNION ALL ".join(
        f"SELECT current_date() AS usage_date, '1' AS workspace_id, 'id_{name}' AS app_id, "
        f"'{name}' AS app_name, 5.0 AS dbus"
        for name in APPS
    )


def _ds_apps_sql():
    dash = yaml.safe_load((BUNDLE / "resources/apps_monitoring.dashboard.yml").read_text())
    serialized = dash["resources"]["dashboards"]["apps_monitoring_dashboard"]["serialized_dashboard"]
    ds = {d["name"]: d for d in json.loads(serialized)["datasets"]}["ds_apps"]
    q = "".join(ds["queryLines"])
    for table, fixture in (
        ("${var.name_prefix}apps_inventory_snapshot", "fx_snapshot"),
        ("${var.name_prefix}app_obo_activity_daily", "fx_obo"),
        ("${var.name_prefix}app_access_activity_daily", "fx_access"),
        ("${var.name_prefix}app_billing_daily", "fx_billing"),
    ):
        assert table in q, table
        q = q.replace(table, fixture)
    assert q.startswith("WITH ")
    fixtures = (
        f"fx_snapshot AS ({_snapshot()}), fx_obo AS ({_obo()}), "
        f"fx_access AS ({_access()}), fx_billing AS ({_billing()}), "
    )
    return "WITH " + fixtures + q[len("WITH "):]


@pytest.fixture(scope="module")
def result():
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.sql import StatementParameterListItem as P

    w = WorkspaceClient(profile=PROFILE)
    r = w.statement_execution.execute_statement(
        statement=_ds_apps_sql(),
        warehouse_id=WAREHOUSE,
        wait_timeout="50s",
        parameters=[
            P(name="usage_days", value=str(USAGE_DAYS), type="INT"),
            P(name="stale_days", value="60", type="INT"),
            P(name="creator_app_threshold", value="3", type="INT"),
        ],
    )
    assert r.status.error is None, r.status.error
    cols = [c.name for c in r.manifest.schema.columns]
    return {row[cols.index("app_name")]: dict(zip(cols, row)) for row in r.result.data_array}


def test_all_four_activity_types(result):
    assert {a: r["activity_type"] for a, r in result.items()} == {
        "fx_login_only": "Idle",
        "fx_obo": "OBO",
        "fx_sp": "SP-only",
        "fx_sp_obo": "SP and OBO",
        "fx_idle": "Idle",
        "fx_own_sp": "Idle",
        "fx_old": "Idle",
    }


def test_candidates_are_exactly_the_apps_with_no_usage_at_all(result):
    candidates = {a for a, r in result.items() if r["is_deletion_candidate"] == "1"}
    assert candidates == {"fx_idle", "fx_own_sp", "fx_old"}
    for a in candidates:
        r = result[a]
        assert (r["human_login_users"], r["human_obo_events"], r["sp_events_window"]) == ("0", "0", "0"), a
        assert r["candidate_label"] == "Deletion candidate"


def test_login_only_app_is_used(result):
    r = result["fx_login_only"]
    assert r["has_human_login"] == "true" and r["human_login_users"] == "1"
    assert r["flag_no_usage"] == "0" and r["is_deletion_candidate"] == "0"
    assert r["wasted_dbus"] == "0.0"


def test_sp_activity_prevents_candidacy_despite_informational_flags(result):
    r = result["fx_sp"]
    for flag in ("flag_no_human_usage", "flag_billed_no_users", "flag_sp_only",
                 "flag_stopped_or_never_deployed", "flag_stale_deploy", "flag_creator_inactive"):
        assert r[flag] == "1", flag
    assert r["is_deletion_candidate"] == "0" and r["candidate_label"] == "Keep"
    assert r["wasted_dbus"] == "0.0"
    assert "no_human_usage" in r["reasons"] and "no_usage," not in r["reasons"] + ","


def test_own_sp_is_not_human_obo_or_login(result):
    r = result["fx_own_sp"]
    assert (r["human_obo_users"], r["human_obo_events"], r["human_login_users"]) == ("0", "0", "0")
    assert r["is_deletion_candidate"] == "1"


def test_idle_app_is_candidate_and_its_dbus_are_wasted(result):
    r = result["fx_idle"]
    assert r["flag_no_usage"] == "1" and r["is_deletion_candidate"] == "1"
    assert float(r["wasted_dbus"]) == 5.0
    assert r["reasons"].startswith("no_usage")


def test_activity_outside_window_does_not_count(result):
    r = result["fx_old"]
    assert r["is_deletion_candidate"] == "1"
    assert r["last_sp_activity_date"] is not None and r["last_login_date"] is not None
