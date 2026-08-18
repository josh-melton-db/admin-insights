import type { Actor } from '../../shared/admin-insights';
import { getOboWorkspaceClient } from './workspace-client';

const SCIM_FILTER_QUOTE = /["\\]/g;

export function quotedScimValue(value: string): string {
  return value.replace(SCIM_FILTER_QUOTE, '\\$&');
}

function configuredValues(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface IdentityRequest {
  get(name: string): string | undefined;
}

export class IdentityResolver {
  private readonly bootstrapAdmins = configuredValues('ADMIN_INSIGHTS_BOOTSTRAP_ADMINS');
  private readonly adminGroups = configuredValues('ADMIN_INSIGHTS_ADMIN_GROUPS');

  getActorEmail(req: IdentityRequest): string {
    const forwardedEmail = req.get('x-forwarded-email') ?? req.get('x-forwarded-user');
    const developmentFallback =
      process.env.NODE_ENV === 'development' ? process.env.ADMIN_INSIGHTS_DEV_USER : undefined;
    const email = forwardedEmail ?? developmentFallback;
    if (!email) {
      throw new Error('A trusted Databricks proxy identity header is required');
    }
    return email.toLowerCase();
  }

  async resolveActor(req: IdentityRequest, roles: string[]): Promise<Actor> {
    const email = this.getActorEmail(req);
    const isBootstrapAdmin = this.bootstrapAdmins.has(email);
    const isRoleAdmin = roles.includes('admin');
    const isGroupAdmin =
      !isBootstrapAdmin &&
      !isRoleAdmin &&
      this.adminGroups.size > 0 &&
      (await this.userBelongsToAdminGroup(req, email));
    const isAdmin = isBootstrapAdmin || isRoleAdmin || isGroupAdmin;

    return {
      email,
      displayName: email,
      roles,
      isAdmin,
      isRequester: isAdmin || roles.includes('requester'),
      isAuditor: isAdmin || roles.includes('auditor'),
    };
  }

  private async userBelongsToAdminGroup(req: IdentityRequest, email: string): Promise<boolean> {
    try {
      const client = getOboWorkspaceClient(req);
      const filter = `userName eq "${quotedScimValue(email)}"`;
      for await (const user of client.usersV2.list({ filter })) {
        const groups = (user.groups ?? [])
          .map((group) => group.display?.toLowerCase() ?? group.value?.toLowerCase())
          .filter((group): group is string => Boolean(group));
        return groups.some((group) => this.adminGroups.has(group));
      }
      return false;
    } catch {
      return false;
    }
  }
}
