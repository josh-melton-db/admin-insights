import { analytics, createApp, lakebase, server } from '@databricks/appkit';
import { MutationExecutor } from './admin-insights/executor';
import { IdentityResolver } from './admin-insights/identity';
import { asLakebaseQuery, runMigrations } from './admin-insights/migrations';
import { registerAdminInsightsRoutes } from './admin-insights/routes';
import { AdminInsightsService } from './admin-insights/service';
import { AdminInsightsStore } from './admin-insights/store';

createApp({
  plugins: [analytics({ timeout: 60_000 }), lakebase(), server()],
  async onPluginsReady(appkit) {
    const runMigrationsOnStartup =
      process.env.NODE_ENV !== 'development' || process.env.ADMIN_INSIGHTS_RUN_MIGRATIONS === 'true';
    const lakebase = asLakebaseQuery(appkit.lakebase);
    if (runMigrationsOnStartup) {
      await runMigrations(lakebase);
    } else {
      console.warn(
        'Skipping Lakebase migrations in local development. Deploy first so the app service principal owns the admin_app schema, or explicitly set ADMIN_INSIGHTS_RUN_MIGRATIONS=true for an isolated development branch.',
      );
    }
    const store = new AdminInsightsStore(lakebase);
    const identity = new IdentityResolver();
    const executor = new MutationExecutor(store);
    const adminInsights = new AdminInsightsService(store, identity, executor);
    appkit.server.extend((app) => {
      registerAdminInsightsRoutes(app, adminInsights);
    });
  },
}).catch(console.error);
