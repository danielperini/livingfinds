import { pathToFileURL } from 'node:url';

export const requiredFunctions = ['startMotorExecution', 'getMotorExecutionRun', 'listMotorExecutions', 'createOptimizationDecisionIdempotent'];

export async function verifyPublicDeploy({ base, sha, fetchFn = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 12, timeoutMs = 5000 }) {
  let diagnostic = 'not_checked';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const responses = await Promise.all(['/health', '/functions'].map((path) => fetchFn(
        `${base}${path}?deploy_verify=${encodeURIComponent(sha)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) },
      )));
      if (responses.some((response) => !response.ok)) {
        diagnostic = `health_http=${responses[0].status}|functions_http=${responses[1].status}`;
      } else {
        const [health, catalog] = await Promise.all(responses.map((response) => response.json()));
        const missing = requiredFunctions.filter((name) => !catalog.functions?.includes(name));
        if (health.release_sha === sha && health.db === true && health.scheduler?.enabled === true && health.motor_worker?.enabled === true && missing.length === 0) {
          return { sha, attempt };
        }
        diagnostic = `served_sha=${health.release_sha ?? 'missing'}|db=${health.db}|scheduler=${health.scheduler?.enabled}|worker=${health.motor_worker?.enabled}|missing_functions=${missing.join(',')}`;
      }
    } catch (error) {
      // Do not log response bodies, headers or authentication data.
      diagnostic = `request_error=${error.name}`;
    }
    if (attempt < attempts) await wait(2000);
  }
  throw new Error(`PUBLIC_DEPLOY_VERIFY=failed|expected_sha=${sha}|${diagnostic}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyPublicDeploy({ base: process.env.LIVE_BASE_URL, sha: process.env.RELEASE_SHA });
  console.log(`PUBLIC_DEPLOY_VERIFY=confirmed|sha=${result.sha}|attempt=${result.attempt}|db=healthy|scheduler=enabled|worker=enabled`);
}
