"""Static checks that every UC object the bundle touches carries name_prefix."""
import json
import re
from pathlib import Path

import yaml

BUNDLE = Path(__file__).resolve().parents[1]
REPO = BUNDLE.parents[1]
TABLES = ("apps_inventory_snapshot", "app_obo_activity_daily", "app_config_events_daily")


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
    for table in ("apps_inventory_snapshot", "app_obo_activity_daily"):
        assert "${var.name_prefix}" + table in joined


def test_refresh_sql_builds_prefixed_names_and_validates_prefix():
    sql = sql_code(BUNDLE / "src/refresh_app_mvs.sql")
    assert ":name_prefix || 'app_obo_activity_daily'" in sql
    assert ":name_prefix || 'app_config_events_daily'" in sql
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
    assert [name for name, _ in sets] == ["obo_mv", "config_mv"]
    for name, _ in sets:
        assert sql.index(f"SET {name} =") > last_guard
    # No statement names an MV literally; every one runs on obo_mv/config_mv.
    assert not re.search(r"^\s*(CREATE|ALTER|REFRESH|DROP)\b", sql, re.M | re.I)
    targets = re.findall(r"EXECUTE IMMEDIATE '([A-Z ]+?) ' \|\| (\w+)", sql)
    assert sorted(targets) == sorted([
        ("CREATE MATERIALIZED VIEW IF NOT EXISTS", "obo_mv"),
        ("CREATE MATERIALIZED VIEW IF NOT EXISTS", "config_mv"),
        ("ALTER MATERIALIZED VIEW", "obo_mv"),
        ("ALTER MATERIALIZED VIEW", "config_mv"),
        ("REFRESH MATERIALIZED VIEW", "obo_mv"),
        ("REFRESH MATERIALIZED VIEW", "config_mv"),
    ])
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
    assert len(_select_bodies(shared_sql)) == 2
    assert _select_bodies(bundle_sql) == _select_bodies(shared_sql)


def test_shared_mvs_self_refresh_daily_again():
    shared_sql = sql_code(REPO / "sql/governance/06_app_activity_daily_mvs.sql")
    assert shared_sql.count("SCHEDULE EVERY 1 DAY") == 2
