CREATE OR REPLACE VIEW demos.admin_insights.access_activity_metrics
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
source: demos.admin_insights.native_access_activity_daily
comment: "Certified access-request and governance activity metrics at daily requester, securable, privilege, and workspace grain. Owner: Admin Insights administrators."
dimensions:
  - name: Activity Date
    expr: activity_date
    comment: "UTC date on which the native request-for-access audit event occurred."
    display_name: "Activity date"
    synonyms: ["event date", "request date", "day"]
  - name: Request Source
    expr: request_source
    comment: "The access-request system that emitted the activity."
    display_name: "Request source"
    synonyms: ["source system", "request channel"]
  - name: Event Category
    expr: event_category
    comment: "Business category for a native request submission or destination-management event."
    display_name: "Event category"
    synonyms: ["activity type", "request event type"]
  - name: Action Name
    expr: action_name
    comment: "Databricks audit action name."
    display_name: "Audit action"
    synonyms: ["action", "event action"]
  - name: Workspace Id
    expr: workspace_id
    comment: "Workspace that recorded the native access-request event."
    display_name: "Workspace"
    synonyms: ["workspace", "workspace identifier"]
  - name: Requester
    expr: requester
    comment: "Identity that made the request-for-access API call."
    display_name: "Requester"
    synonyms: ["requesting user", "requestor", "actor"]
  - name: On Behalf Of Subject
    expr: on_behalf_of_subject
    comment: "Subject identified when the request was made on behalf of another identity."
    display_name: "On-behalf-of subject"
    synonyms: ["requested-for", "target principal", "beneficiary"]
  - name: Securable Name
    expr: securable_name
    comment: "Catalog, schema, table, volume, or other securable identified in the event payload."
    display_name: "Securable"
    synonyms: ["resource", "data asset", "object"]
  - name: Privilege
    expr: privilege
    comment: "Requested Unity Catalog privilege from the native event payload."
    display_name: "Requested privilege"
    synonyms: ["permission", "access level", "grant"]
  - name: Destination Status
    expr: destination_status
    comment: "Access-request destination status supplied by the native audit-event payload, when applicable."
    display_name: "Destination status"
    synonyms: ["routing status", "approval destination state"]
measures:
  - name: Native Event Count
    expr: COUNT(DISTINCT event_id)
    comment: "Distinct native request-for-access audit events."
    display_name: "Native access events"
    synonyms: ["access event count", "audit events"]
    format:
      type: number
      decimal_places:
        type: exact
        places: 0
  - name: Native Request Count
    expr: COUNT(DISTINCT request_id)
    comment: "Distinct native request IDs across the normalized event fact."
    display_name: "Native access requests"
    synonyms: ["request count", "UC access requests"]
    format:
      type: number
      decimal_places:
        type: exact
        places: 0
  - name: Failed Event Count
    expr: COUNT(DISTINCT CASE WHEN response_status_code >= 400 THEN event_id END)
    comment: "Distinct native request-for-access audit events with an HTTP-style response status of 400 or greater."
    display_name: "Failed access events"
    synonyms: ["request failures", "error count"]
    format:
      type: number
      decimal_places:
        type: exact
        places: 0
$$;

ALTER VIEW demos.admin_insights.access_activity_metrics
SET TAGS ('certified' = 'true');
