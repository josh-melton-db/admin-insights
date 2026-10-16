"""Static checks that every UC object the bundle touches carries name_prefix."""
import json
import re
from pathlib import Path

import yaml

BUNDLE = Path(__file__).resolve().parents[1]
REPO = BUNDLE.parents[1]
TABLES = ("apps_inventory_snapshot", "app_obo_activity_daily", "app_config_events_daily", "app_access_activity_daily")
APP_FILTER = "identity_metadata.acting_resource LIKE 'accounts/%/oauth2/custom-app-integrations/%'"


def sql_code(path):
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("--"))


def load(rel):
    return yaml.safe_load((BUNDLE / rel).read_text())


def test_name_prefix_variable_empty_by_default_and_monitor_in_default_target():
    cfg = load("databricks.yml")
    assert cfg["variables"]["name_prefix"]["default"] == ""
    assert cfg["variables"]["name_prefix"]["description"]
    assert cfg["targets"]["default"]["variables"]["name_prefix"] == "monitor_"


def test_job_passes_name_prefix_to_both_tasks():
    job = load("resources/apps_monitoring.job.yml")["resources"]["jobs"]["apps_monitoring"]
    assert {"name": "name_prefix", "default": "${var.name_prefix}"} in job["parameters"]
    tasks = {t["task_key"]: t for t in job["tasks"]}
    params = tasks["snapshot_apps_inventory"]["spark_python_task"]["parameters"]
    assert params[params.index("--name-prefix") + 1] == "{{job.parameters.name_prefix}}"
    assert tasks["refresh_app_mvs"]["sql_task"]["parameters"]["name_prefix"] == "{{job.parameters.name_prefix}}"


def test_every_dashboard_table_reference_is_prefixed():
    dash = load("resources/apps_monitoring.dashboard.yml")["resources"]["dashboards"]["apps_monitoring_dashboard"]
    serialized = dash["serialized_dashboard"]
    assert "monitor_" not in serialized
    queries = ["".join(d["queryLines"]) for d in json.loads(serialized)["datasets"]]
    assert queries
    for q in queries:
        for table in TABLES:
            bare = re.findall(rf"(?<![\w}}]){table}\b", q)
            assert not bare, f"unprefixed {table} in dataset query"
    joined = "\n".join(queries)
    for table in ("apps_inventory_snapshot", "app_obo_activity_daily", "app_access_activity_daily"):
        assert "${var.name_prefix}" + table in joined


def test_refresh_sql_builds_prefixed_names_and_validates_prefix():
    sql = sql_code(BUNDLE / "src/refresh_app_mvs.sql")
    assert ":name_prefix || 'app_obo_activity_daily'" in sql
    assert ":name_prefix || 'app_config_events_daily'" in sql
    assert ":name_prefix || 'app_access_activity_daily'" in sql
    assert re.search(r"regexp_replace\(:name_prefix, '\[A-Za-z0-9_\]', ''\) <> ''", sql)
    assert "SCHEDULE EVERY" not in sql
    assert "DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST" in sql


def test_refresh_sql_rejects_null_parameters():
    # A NULL marker makes "regexp_replace(...) <> ''" NULL, not TRUE, so each
    # parameter needs an explicit IS NULL guard ahead of any statement.
    sql = sql_code(BUNDLE / "src/refresh_app_mvs.sql")
    first_set = sql.index("SET obo_mv")
    for param in (":catalog", ":schema", ":name_prefix"):
        guard = sql.find(f"{param} IS NULL")
        assert 0 <= guard < first_set, f"missing IS NULL guard for {param}"


def test_every_mv_statement_targets_a_validated_name():
    sql = sql_code(BUNDLE / "src/refresh_app_mvs.sql")
    last_guard = sql.rindex("SIGNAL SQLSTATE")
    # Names are assigned exactly once, after all validation.
    sets = re.findall(r"^\s*SET (\w+) = (.*);", sql, re.M)
    assert [name for name, _ in sets] == ["obo_mv", "config_mv", "access_mv"]
    for name, _ in sets:
        assert sql.index(f"SET {name} =") > last_guard
    # No statement names an MV literally; every one runs on a validated name.
    assert not re.search(r"^\s*(CREATE|ALTER|REFRESH|DROP)\b", sql, re.M | re.I)
    targets = re.findall(r"EXECUTE IMMEDIATE '([A-Z ]+?) ' \|\| (\w+)", sql)
    # CREATE OR REPLACE applies definition changes to existing MVs and
    # recomputes them, so there is no separate REFRESH.
    mvs = ["obo_mv", "config_mv", "access_mv"]
    assert sorted(targets) == sorted(
        [("CREATE OR REPLACE MATERIALIZED VIEW", mv) for mv in mvs]
        + [("ALTER MATERIALIZED VIEW", mv) for mv in mvs]
    )
    assert sql.count("EXECUTE IMMEDIATE") == len(targets)


def test_no_workspace_identifiers_committed():
    cfg = load("databricks.yml")
    assert "default" not in cfg["variables"]["warehouse_id"]
    assert "workspace" not in cfg["targets"]["default"]
    example = json.loads((BUNDLE / "variable-overrides.example.json").read_text())
    assert set(example) == {"warehouse_id"}
    assert example["warehouse_id"].startswith("<")


def _select_bodies(sql):
    return [re.sub(r"\s+", " ", b).strip() for b in re.findall(r"\nAS\n(SELECT.*?)(?:;|\"\;)", sql, re.S)]


def test_mv_definitions_match_shared_governance_sql():
    bundle_sql = (BUNDLE / "src/refresh_app_mvs.sql").read_text()
    shared_sql = (REPO / "sql/governance/06_app_activity_daily_mvs.sql").read_text()
    shared = _select_bodies(shared_sql)
    assert len(shared) == 2
    # The bundle also owns app_access_activity_daily, which has no shared copy.
    bundle = _select_bodies(bundle_sql)
    assert bundle[:2] == shared
    assert len(bundle) == 3
    assert "app_access_activity_daily" not in shared_sql


def test_obo_mv_keeps_only_databricks_apps_and_appends_client_id():
    for path in (BUNDLE / "src/refresh_app_mvs.sql", REPO / "sql/governance/06_app_activity_daily_mvs.sql"):
        obo = _select_bodies(path.read_text())[0]
        assert APP_FILTER in obo
        assert "acting_resource IS NOT NULL" not in obo
        select_list = obo.split(" FROM ")[0]
        # Appended last so existing column positions are unchanged.
        assert select_list.endswith(
            "count(*) AS event_count, regexp_extract(identity_metadata.acting_resource, '([^/]+)$', 1) AS oauth2_app_client_id"
        )
        assert "OAuth app ID or name" not in path.read_text()


def test_access_mv_signals():
    access = _select_bodies((BUNDLE / "src/refresh_app_mvs.sql").read_text())[2]
    select_list = access.split(" FROM ")[0]
    for col in ("activity_date", "workspace_id", "oauth2_app_client_id", "user_email", "signal", "event_count"):
        assert re.search(rf"\b{col}\b", select_list), col
    # Human login: a successful browser authorization-code grant for the app's OAuth client.
    assert "action_name = 'mintOAuthAuthorizationCode'" in access
    assert "request_params['client_id']" in access
    assert "response.status_code = 200" in access
    # Consent is account-level and keyed by integration_id.
    assert "action_name = 'createOrUpdateOAuthAppUserConsentEvent'" in access
    assert "request_params['integration_id']" in access
    # Token minting (client_credentials, refresh) is not a visit.
    assert "action_name = 'mintOAuthToken'" not in access
    for signal in ("'login'", "'consent'", "'sp_activity'"):
        assert signal in access
    # SP activity excludes token/auth and source-export actions every running app emits.
    for noise in ("oidcTokenAuthorization", "workspaceInHouseOAuthClientAuthentication", "mintOAuthToken", "tokenLogin", "workspaceExport"):
        assert f"'{noise}'" in access


def _ds_apps():
    dash = load("resources/apps_monitoring.dashboard.yml")["resources"]["dashboards"]["apps_monitoring_dashboard"]
    return json.loads(dash["serialized_dashboard"])


def _query(name):
    ds = {d["name"]: d for d in _ds_apps()["datasets"]}[name]
    return re.sub(r"\s+", " ", "".join(ds["queryLines"]))


def test_dashboard_matches_obo_on_client_id_only():
    for name in ("ds_apps", "ds_usage_trend"):
        q = _query(name)
        assert "o.oauth2_app_client_id = s.oauth2_app_client_id" in q
        # OBO rows are mostly workspace_id = 0, so workspace equality drops them.
        assert "o.workspace_id = s.workspace_id" not in q
        assert "IN (s.oauth2_app_client_id, s.app_id, s.app_name)" not in q
        # The app's own SP is not a human user.
        assert "o.user_email LIKE '%@%'" in q
        assert "o.user_email IS DISTINCT FROM s.service_principal_client_id" in q


def test_dashboard_usage_definition():
    q = _query("ds_apps")
    for col in ("human_login_users", "last_login_date", "has_human_login", "human_obo_users",
                "last_obo_date", "last_sp_activity_date", "activity_type"):
        assert re.search(rf"\b{col}\b", q), col
    for tier in ("'SP-only'", "'OBO'", "'SP and OBO'", "'Idle'"):
        assert tier in q
    assert "a.user_email = s.service_principal_client_id" in q
    assert "flag_no_usage" in q
    # no_usage = no human login, no human OBO, and no SP activity: SP activity is
    # the app doing work (often for users), so it counts as usage.
    assert re.search(
        r"CASE WHEN coalesce\(l\.login_users_window, 0\) = 0 AND coalesce\(o\.obo_events_window, 0\) = 0"
        r" AND coalesce\(p\.sp_events_window, 0\) = 0 THEN 1 ELSE 0 END AS flag_no_usage", q)
    assert re.search(
        r"CASE WHEN coalesce\(l\.login_users_window, 0\) = 0 AND coalesce\(o\.obo_events_window, 0\) = 0"
        r" THEN 1 ELSE 0 END AS flag_no_human_usage", q)


def test_deletion_candidate_is_no_usage_only():
    q = _query("ds_apps")
    # Candidacy and wasted DBUs depend on no_usage alone; the other flags are informational.
    assert "CASE WHEN flag_no_usage = 1 THEN 1 ELSE 0 END AS is_deletion_candidate" in q
    assert "CASE WHEN flag_no_usage = 1 THEN 'Deletion candidate' ELSE 'Keep' END AS candidate_label" in q
    assert "CASE WHEN flag_no_usage = 1 THEN dbus_window ELSE 0 END AS wasted_dbus" in q
    final = q[q.rindex("FROM facts") - 2000:]
    for flag in ("has_user_scopes = 1", "flag_stopped_or_never_deployed = 1 OR", "flag_stale_deploy = 1 OR",
                 "flag_creator_inactive = 1)", "activity_type = 'Idle'"):
        assert flag not in final, flag


def test_dashboard_text_counts_sp_activity_as_usage():
    serialized = load("resources/apps_monitoring.dashboard.yml")["resources"]["dashboards"][
        "apps_monitoring_dashboard"]["serialized_dashboard"]
    readme = (BUNDLE / "README.md").read_text()
    for text in (serialized, readme):
        assert "background or operational" not in text
        assert "SP activity" in text


def test_dashboard_has_activity_type_filter_and_login_column():
    dash = _ds_apps()
    widgets = [l["widget"] for p in dash["pages"] for l in p["layout"]]
    filters = [w for w in widgets if w.get("spec", {}).get("widgetType", "").startswith("filter")]
    assert any(
        f["fieldName"] == "activity_type"
        for w in filters for f in w["spec"]["encodings"]["fields"]
    )
    tables = [w for w in widgets if w.get("spec", {}).get("widgetType") == "table"
              and any(q["query"]["datasetName"] == "ds_apps" for q in w["queries"])]
    cols = [c["fieldName"] for t in tables for c in t["spec"]["encodings"]["columns"]]
    assert "activity_type" in cols and "human_login_users" in cols
    assert cols.index("human_login_users") == cols.index("activity_type") + 1


def test_shared_mvs_self_refresh_daily_again():
    shared_sql = sql_code(REPO / "sql/governance/06_app_activity_daily_mvs.sql")
    assert shared_sql.count("SCHEDULE EVERY 1 DAY") == 2
