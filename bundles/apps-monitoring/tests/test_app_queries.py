"""Static checks for the admin-insights app's Apps queries in config/queries."""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SNAPSHOT = "demos.admin_insights.monitor_apps_inventory_snapshot"


def query(name):
    text = (REPO / "config/queries" / name).read_text()
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("--"))
    return text, re.sub(r"\s+", " ", code)


def test_app_queries_map_billing_to_client_id_via_snapshot():
    for name in ("hygiene_app_usage.obo.sql", "roi_wasted_spend_trend.obo.sql"):
        text, q = query(name)
        assert SNAPSHOT in q, name
        assert "apps-monitoring" in text and "monitor_" in text, name
        assert "o.oauth2_app_client_id = m.oauth2_app_client_id" in q, name
        # OBO rows are mostly workspace_id = 0; never match them on workspace.
        obo_join = re.search(r"app_obo_activity_daily o ON (.*?) (?:GROUP BY|\)|LEFT JOIN|INNER JOIN)", q).group(1)
        assert "workspace_id" not in obo_join, name
        assert "workspace_id = :workspaceId" not in q.split("app_obo_activity_daily o")[1].split("),")[0], name
        assert "o.acting_resource IN" not in q, name
        # The app's own SP is not a human user.
        assert "o.user_email LIKE '%@%'" in q, name
        assert "o.user_email IS DISTINCT FROM m.service_principal_client_id" in q, name


def test_hygiene_app_usage_marks_unmapped_apps():
    _, q = query("hygiene_app_usage.obo.sql")
    assert "WHEN m.app_id IS NULL THEN 'obo_unmapped'" in q
    # Unmapped apps report NULL OBO counts, not 0.
    assert "CASE WHEN m.app_id IS NULL THEN NULL ELSE coalesce(o.user_obo_events, 0) END AS user_obo_events" in q
    # Existing columns keep their names and order.
    cols = ["workspace_id", "app_id", "app_name", "dbus", "last_usage_date", "user_obo_events",
            "user_obo_users", "last_obo_date", "user_api_scopes", "scope_band", "usage_band"]
    final = q[q.rindex("SELECT "):]
    positions = [final.index(re.search(rf"(\b|\.){c}\b", final).group(0)) for c in cols]
    assert positions == sorted(positions)


def test_wasted_spend_does_not_count_unmapped_apps():
    _, q = query("roi_wasted_spend_trend.obo.sql")
    assert "'app_obo_unmapped'" in q
    assert "WHEN waste_kind IS NOT NULL AND waste_kind <> 'app_obo_unmapped' THEN list_cost" in q
