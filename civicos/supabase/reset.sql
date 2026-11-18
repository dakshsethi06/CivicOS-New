-- Removes everything CivicOS created, so all_migrations.sql can be run again from scratch.
-- Use this only if you ran an earlier version of the migrations. It deletes all CivicOS data
-- in this project. Auth users are kept; delete them under Authentication -> Users for a clean start.
-- Uploaded files and the two storage buckets are kept.

-- functions (every version, whatever its arguments)
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('api_indicators', 'assistant_facts', 'assistant_history', 'assistant_retrieve', 'assistant_save', 
        'audit_recent', 'change_plan', 'complaint_action', 'complaint_detail', 'complaint_list', 'create_api_key', 
        'dashboard_data', 'forecast_extras', 'document_create', 'document_finish', 'indicator_rows', 'map_data', 'ml_data', 
        'platform_overview', 'recommendation_decide', 'recommendation_list', 'refresh_recommendations', 
        'register_organization', 'revoke_api_key', 'search_documents',
        'submit_complaint', 'usage_summary', 'ward_stats',
        'match_document_chunks', 'assistant_quota', 'complaint_summary',
        'ops_status', 'ops_water', 'ops_waste', 'ops_traffic', 'water_anomaly_review', 'ops_summary', 'map_layers',
        'complaint_similar', 'complaint_ai_apply', 'complaint_ai_view', 'assistant_ops', 'assistant_nearby',
        'task_create', 'task_action', 'submit_inspection', 'work_list', 'task_detail', 'complaint_reports',
        'invitation_create', 'accept_invitation', 'invitation_revoke', 'document_chunks_by_ids')
  loop
    execute 'drop function if exists ' || f || ' cascade';
  end loop;
end $$;

-- tables, including ones from earlier versions that no longer exist
drop table if exists
  public.environment_readings, public.traffic_incidents, public.traffic_readings,
  public.waste_readings, public.waste_bins, public.water_readings, public.water_sensors,
  public.ops_datasets, public.ops_jobs, public.model_runs, public.water_reservoirs, public.reservoir_readings,
  public.water_pipelines, public.water_anomalies, public.water_predictions, public.pipeline_risk, public.reservoir_risk,
  public.waste_predictions, public.collection_vehicles, public.collection_plans, public.collection_routes,
  public.traffic_networks, public.roads, public.weather_readings, public.traffic_predictions, public.traffic_simulations,
  public.complaint_embeddings, public.inspection_reports, public.work_tasks,
  public.api_keys, public.assistant_conversations, public.assistant_messages, public.audit_logs, public.cities, 
  public.city_zones, public.civic_indicators, public.complaint_categories, public.complaint_history, 
  public.complaints, public.data_sources, public.departments, public.document_embeddings, public.document_chunks, public.documents,
  public.health_index_config, public.health_index_snapshots, public.infrastructure_assets, public.invitations, 
  public.ml_forecasts, public.ml_models, public.ml_ward_clusters, public.organizations, public.permissions, 
  public.plans, public.recommendation_decisions, public.recommendations, public.retrieval_logs, 
  public.role_permissions, public.roles, public.subscriptions, public.usage_records, public.users
  cascade;
drop sequence if exists public.complaint_ref_seq, public.work_task_ref_seq;
drop schema if exists app cascade;
drop schema if exists alembic cascade;   -- Alembic's record of applied migrations
