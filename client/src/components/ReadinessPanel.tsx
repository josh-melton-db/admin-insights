import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@databricks/appkit-ui/react';
import { useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { QueryPanel } from './QueryPanel';

const REQUIRED_TABLES = [
  'query.history',
  'billing.usage',
  'billing.list_prices',
  'lakeflow.jobs',
  'lakeflow.job_task_run_timeline',
  'serving.endpoint_usage',
  'serving.served_entities',
  'ai_gateway.usage',
  'access.audit',
  'access.table_lineage',
  'storage.table_metrics_history',
  'compute.clusters',
  'compute.node_timeline',
  'compute.warehouses',
  'compute.warehouse_events',
];

const OPTIONAL_TABLES = ['data_classification.results', 'data_quality_monitoring.table_results'];

export function ReadinessPanel() {
  const { data, loading, error } = useAnalyticsQuery('readiness_system_tables', {});
  const visible = new Set((data ?? []).map((row) => `${row.table_schema}.${row.table_name}`));
  const missingRequired = REQUIRED_TABLES.filter((name) => !visible.has(name));
  const missingOptional = OPTIONAL_TABLES.filter((name) => !visible.has(name));

  return (
    <Card>
      <CardHeader>
        <CardTitle>System-table readiness</CardTitle>
        <CardDescription>
          Sensitive-object and row-count panels stay on “not collected” until SELECT is granted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <QueryPanel
          loading={loading}
          error={error}
          empty={!data?.length}
          emptyTitle="No system schemas visible"
          emptyDescription="Grant USE CATALOG on system and the schemas listed in sql/governance/05_admin_obo_grants.template.sql."
        >
          <div className="flex flex-wrap gap-2">
            {(data ?? []).slice(0, 24).map((row) => (
              <Badge key={`${row.table_schema}.${row.table_name}`} variant="secondary">
                {row.table_schema}.{row.table_name}
              </Badge>
            ))}
          </div>
        </QueryPanel>
        <Alert>
          <AlertTitle>Missing grants to apply</AlertTitle>
          <AlertDescription>
            <p>
              Grant SELECT on <code>system.data_classification.results</code> and{' '}
              <code>system.data_quality_monitoring.table_results</code> to the admin group before expecting
              sensitive-object or row-count evidence. Storage bytes stay “not collected” while{' '}
              <code>system.storage.table_metrics_history</code> has zero rows.
            </p>
            {missingRequired.length > 0 ? (
              <p className="mt-2">Not visible yet: {missingRequired.join(', ')}</p>
            ) : null}
            {missingOptional.length > 0 ? (
              <p className="mt-2">Optional tables not visible: {missingOptional.join(', ')}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
