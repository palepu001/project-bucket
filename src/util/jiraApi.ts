import api from '@forge/api';

/**
 * Makes a request to Jira REST API, attempting asUser() first, and falling
 * back to asApp() if asUser() fails due to AUTH_TYPE_UNAVAILABLE (which happens
 * during async background worker execution where no user session exists).
 */
export async function requestJiraSmart(restRoute: any, options?: any): Promise<any> {
  try {
    return await api.asUser().requestJira(restRoute, options);
  } catch (err: any) {
    if (
      err?.errorCode === 'AUTH_TYPE_UNAVAILABLE' ||
      err?.status === 401 ||
      String(err?.message || err).includes('AUTH_TYPE_UNAVAILABLE')
    ) {
      return await api.asApp().requestJira(restRoute, options);
    }
    throw err;
  }
}
