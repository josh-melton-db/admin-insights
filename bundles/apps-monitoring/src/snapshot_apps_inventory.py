"""Snapshot the workspace Databricks Apps inventory into a UC table.

Writes <catalog>.<schema>.<name_prefix>apps_inventory_snapshot (overwrite) with
one row per app from WorkspaceClient().apps.list() / apps.get(), plus a
creator-active check against SCIM users and service principals. Catalog,
schema, and name prefix come from job parameters (--catalog / --schema /
--name-prefix), not config files. Catalog and schema must match
^[A-Za-z0-9_]+$; the prefix must match ^[A-Za-z0-9_]*$ (empty allowed).
"""

import argparse
import importlib.metadata
import re
from datetime import datetime, timezone

from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import DatabricksError, NotFound, PermissionDenied, Unauthenticated
from pyspark.sql import SparkSession
from pyspark.sql.types import (
    ArrayType,
    BooleanType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# apps.list/get with oauth2_app_client_id, user_api_scopes, and
# effective_user_api_scopes. The job installs nothing, so this is the SDK the
# serverless environment preinstalls: 0.67.0 in environment_version 5.
MIN_SDK_VERSION = (0, 49, 0)
# PEP 440 release, optional pre (a/b/rc), post, dev, and local segments.
SDK_VERSION_RE = re.compile(
    r"v?(?P<release>\d+(?:\.\d+)*)"
    r"(?:[-_.]?(?P<pre>a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)?"
    r"(?P<post>[-_.]?(?:post|rev|r)[-_.]?\d*|-\d+)?"
    r"(?P<dev>[-_.]?dev[-_.]?\d*)?"
    r"(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?",
    re.I,
)
IDENTIFIER_RE = re.compile(r"[A-Za-z0-9_]+")
NAME_PREFIX_RE = re.compile(r"[A-Za-z0-9_]*")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

SCHEMA = StructType(
    [
        StructField("snapshot_time", TimestampType(), False),
        StructField("workspace_id", StringType(), True),
        StructField("app_name", StringType(), False),
        StructField("app_id", StringType(), True),
        StructField("description", StringType(), True),
        StructField("creator", StringType(), True),
        StructField("creator_type", StringType(), True),
        StructField("creator_active", BooleanType(), True),
        StructField("metadata_incomplete", BooleanType(), False),
        StructField("app_state", StringType(), True),
        StructField("app_status_message", StringType(), True),
        StructField("compute_state", StringType(), True),
        StructField("compute_status_message", StringType(), True),
        StructField("compute_size", StringType(), True),
        StructField("create_time", TimestampType(), True),
        StructField("update_time", TimestampType(), True),
        StructField("updater", StringType(), True),
        StructField("active_deployment_id", StringType(), True),
        StructField("active_deployment_state", StringType(), True),
        StructField("active_deployment_create_time", TimestampType(), True),
        StructField("active_deployment_update_time", TimestampType(), True),
        StructField("pending_deployment_id", StringType(), True),
        StructField("pending_deployment_state", StringType(), True),
        StructField("pending_deployment_create_time", TimestampType(), True),
        StructField("service_principal_id", LongType(), True),
        StructField("service_principal_name", StringType(), True),
        StructField("service_principal_client_id", StringType(), True),
        StructField("oauth2_app_client_id", StringType(), True),
        StructField("url", StringType(), True),
        StructField("user_api_scopes", ArrayType(StringType()), True),
        StructField("effective_user_api_scopes", ArrayType(StringType()), True),
        StructField("budget_policy_id", StringType(), True),
        StructField("effective_budget_policy_id", StringType(), True),
    ]
)


def installed_sdk_version():
    try:
        return importlib.metadata.version("databricks-sdk")
    except importlib.metadata.PackageNotFoundError:
        pass
    try:
        from databricks.sdk.version import __version__
    except ImportError:
        return None
    return __version__


def sdk_version_at_least_floor(version):
    """True/False against MIN_SDK_VERSION, or None if version isn't parseable.

    Pre-releases (a/b/rc, or dev without post) of the floor release sort below
    it; post-releases sort above.
    """
    match = SDK_VERSION_RE.fullmatch(version.strip()) if isinstance(version, str) else None
    if not match:
        return None
    release = tuple(int(p) for p in match["release"].split("."))
    width = max(len(release), len(MIN_SDK_VERSION))
    release += (0,) * (width - len(release))
    floor = MIN_SDK_VERSION + (0,) * (width - len(MIN_SDK_VERSION))
    if release != floor:
        return release > floor
    return not (match["pre"] or (match["dev"] and not match["post"]))


def check_sdk_version(version=None):
    """Return the installed databricks-sdk version, or raise if it's below the floor or unknown."""
    if version is None:
        version = installed_sdk_version()
    if not sdk_version_at_least_floor(version):
        floor = ".".join(map(str, MIN_SDK_VERSION))
        found = repr(version) if version is not None else "unknown"
        raise RuntimeError(
            f"databricks-sdk>={floor} is required, found {found}. Set the job's environment "
            "environment_version to \"5\" (preinstalls 0.67.0) or at least \"4\" (0.49.0) in "
            "resources/apps_monitoring.job.yml."
        )
    return version


def parse_ts(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def enum_value(value):
    if value is None:
        return None
    return getattr(value, "value", str(value))


def deployment_fields(deployment):
    if deployment is None:
        return None, None, None, None
    status = getattr(deployment, "status", None)
    return (
        deployment.deployment_id,
        enum_value(getattr(status, "state", None)),
        parse_ts(getattr(deployment, "create_time", None)),
        parse_ts(getattr(deployment, "update_time", None)),
    )


def validate_name_prefix(prefix):
    if not isinstance(prefix, str) or not NAME_PREFIX_RE.fullmatch(prefix):
        raise ValueError(f"name_prefix must match ^[A-Za-z0-9_]*$, got {prefix!r}")
    return prefix


def snapshot_table_name(catalog, schema, prefix):
    return f"`{catalog}`.`{schema}`.{validate_name_prefix(prefix)}apps_inventory_snapshot"


def classify_creator(w, creator, cache):
    """Return (creator_type, creator_active) for an app creator.

    user: matches a SCIM userName (active flag from SCIM).
    sp: matches a service principal applicationId or displayName.
    Not found: email-shaped -> user, inactive (deleted); UUID-shaped -> sp,
    inactive (deleted); otherwise unknown with creator_active NULL, because a
    failed lookup on an unrecognized name does not confirm the creator is gone.
    """
    if not creator:
        return "unknown", None
    if creator in cache:
        return cache[creator]
    escaped = creator.replace('"', '\\"')
    result = None
    users = list(w.users.list(filter=f'userName eq "{escaped}"', attributes="id,userName,active"))
    if users:
        result = ("user", bool(users[0].active))
    else:
        field = "applicationId" if UUID_RE.match(creator) else "displayName"
        sps = list(
            w.service_principals.list(filter=f'{field} eq "{escaped}"', attributes="id,applicationId,displayName,active")
        )
        if sps:
            result = ("sp", bool(sps[0].active))
        elif "@" in creator:
            result = ("user", False)
        elif UUID_RE.match(creator):
            result = ("sp", False)
        else:
            result = ("unknown", None)
    cache[creator] = result
    return result


def main():
    sdk_version = check_sdk_version()
    print(f"Using preinstalled databricks-sdk {sdk_version}")
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--name-prefix", default="")
    args = parser.parse_args()
    for value in (args.catalog, args.schema):
        if not IDENTIFIER_RE.fullmatch(value):
            raise ValueError(f"catalog and schema must match ^[A-Za-z0-9_]+$, got {value!r}")
    table = snapshot_table_name(args.catalog, args.schema, args.name_prefix)

    w = WorkspaceClient()
    workspace_id = str(w.get_workspace_id())
    snapshot_time = datetime.now(timezone.utc)
    creator_cache = {}

    rows = []
    listed_count = 0
    successful_gets = 0
    failed_gets = 0
    for listed in w.apps.list():
        listed_count += 1
        # apps.list omits app_status and user_api_scopes; apps.get returns them.
        # Apps deleted between list and get are skipped. Other per-app errors
        # keep the list row with metadata_incomplete = true and NULL scopes and
        # status (unknown, not empty). Auth errors fail the run.
        metadata_incomplete = False
        try:
            app = w.apps.get(name=listed.name)
        except NotFound:
            print(f"Skipping {listed.name}: deleted between apps.list and apps.get")
            continue
        except (Unauthenticated, PermissionDenied):
            raise
        except DatabricksError as e:
            print(f"apps.get failed for {listed.name}; keeping list metadata only: {e}")
            app = listed
            metadata_incomplete = True
            failed_gets += 1
        else:
            successful_gets += 1
        creator_type, creator_active = classify_creator(w, getattr(app, "creator", None), creator_cache)
        app_status = getattr(app, "app_status", None)
        compute_status = getattr(app, "compute_status", None)
        active_id, active_state, active_created, active_updated = deployment_fields(getattr(app, "active_deployment", None))
        pending_id, pending_state, pending_created, _ = deployment_fields(getattr(app, "pending_deployment", None))
        rows.append(
            (
                snapshot_time,
                workspace_id,
                getattr(app, "name", None),
                getattr(app, "id", None),
                getattr(app, "description", None),
                getattr(app, "creator", None),
                creator_type,
                creator_active,
                metadata_incomplete,
                None if metadata_incomplete else enum_value(getattr(app_status, "state", None)),
                None if metadata_incomplete else getattr(app_status, "message", None),
                enum_value(getattr(compute_status, "state", None)),
                getattr(compute_status, "message", None),
                enum_value(getattr(app, "compute_size", None)),
                parse_ts(getattr(app, "create_time", None)),
                parse_ts(getattr(app, "update_time", None)),
                getattr(app, "updater", None),
                active_id,
                active_state,
                active_created,
                active_updated,
                pending_id,
                pending_state,
                pending_created,
                getattr(app, "service_principal_id", None),
                getattr(app, "service_principal_name", None),
                getattr(app, "service_principal_client_id", None),
                getattr(app, "oauth2_app_client_id", None),
                getattr(app, "url", None),
                None if metadata_incomplete else list(getattr(app, "user_api_scopes", None) or []),
                None if metadata_incomplete else list(getattr(app, "effective_user_api_scopes", None) or []),
                getattr(app, "budget_policy_id", None),
                getattr(app, "effective_budget_policy_id", None),
            )
        )

    # Abort when no apps.get succeeded and at least one failed (NotFound skips
    # don't count as successes). Zero listed apps, or only confirmed-deleted
    # apps, still writes an empty snapshot.
    if failed_gets and not successful_gets:
        raise RuntimeError(
            f"apps.get failed for {failed_gets} of {listed_count} listed apps with no successful gets; "
            "treating as a workspace-wide error"
        )

    spark = SparkSession.builder.getOrCreate()
    (
        spark.createDataFrame(rows, SCHEMA)
        .write.mode("overwrite")
        .option("overwriteSchema", "true")
        .saveAsTable(table)
    )
    spark.sql(
        f"COMMENT ON TABLE {table} IS 'Daily snapshot of Databricks Apps from the Apps API "
        "(apps.list) with a creator-active check. Overwritten by the apps-monitoring job.'"
    )
    print(
        f"Wrote {len(rows)} apps to {table} at {snapshot_time.isoformat()} "
        f"({failed_gets} with incomplete metadata)"
    )


if __name__ == "__main__":
    main()
