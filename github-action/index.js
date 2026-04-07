const core = require('@actions/core');
const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'headless-oracle-market-gate/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  const mic = core.getInput('mic', { required: true }).toUpperCase();
  const failOnClosed = core.getInput('fail_on_closed') !== 'false';

  core.info(`Checking market status for ${mic}...`);

  const { status: httpStatus, body } = await fetchJSON(
    `https://headlessoracle.com/v5/demo?mic=${mic}`
  );

  if (httpStatus !== 200) {
    core.setFailed(`Oracle returned HTTP ${httpStatus}: ${JSON.stringify(body)}`);
    return;
  }

  const marketStatus = body.status;
  const checkedAt = body.timestamp || new Date().toISOString();

  core.setOutput('status', marketStatus);
  core.setOutput('mic', mic);
  core.setOutput('checked_at', checkedAt);

  core.info(`Market ${mic} is ${marketStatus} (checked at ${checkedAt})`);

  if (failOnClosed && marketStatus !== 'OPEN') {
    core.setFailed(
      `Market ${mic} is ${marketStatus}. ` +
      `Pipeline halted because fail_on_closed is true. ` +
      `To allow execution regardless of market state, set fail_on_closed: false.`
    );
  }
}

run().catch((err) => core.setFailed(err.message));
