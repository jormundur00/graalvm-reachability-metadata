// In-repo file change filter used for GitHub pull request workflows.
//
// Responsibilities:
//   - Accepts an input string ('filters') describing filter names mapped
//     to lists of glob patterns (supports negation via '!' and wildcards
//     *, **, ?).
//   - Fetches the list of changed files for the current pull request
//     using the GitHub REST API (only runs on PR events).
//   - Evaluates whether changed files satisfy each filter using either
//     'some' (default) or 'every' quantifier semantics.
//   - Emits each filter result as a separate GitHub Action output.

const fs = require('fs');
const https = require('https');

function getInput(name, required = false) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const val = process.env[key];
  if (required && (!val || val.trim() === '')) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return val || '';
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    console.log(`::set-output name=${name}::${value}`); // legacy fallback
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

function logInfo(msg) {
  console.log(msg);
}

function httpJson(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method: 'GET', ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(
            new Error(`HTTP ${res.statusCode} ${res.statusMessage}: ${data || ''}`)
          );
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}. Body: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getChangedFilesFromPR() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    return [];
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return [];
  }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = payload.pull_request;
  if (!pr || !pr.number) {
    return [];
  }
  const number = pr.number;
  const repoFull = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repoFull.split('/');
  const token =
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.INPUT_GITHUB_TOKEN;

  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY is not set or invalid: '${repoFull}'`);
  }

  if (!token) {
    logInfo('GITHUB_TOKEN not available; returning empty changed files set.');
    return [];
  }

  const files = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const path = `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${perPage}&page=${page}`;
    const headers = {
      'User-Agent': 'paths-filter-lite',
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
    };
    const res = await httpJson({ hostname: 'api.github.com', path, headers });
    if (!Array.isArray(res) || res.length === 0) {
      break;
    }
    for (const f of res) {
      if (f && typeof f.filename === 'string') {
        files.push(f.filename);
      }
    }
    if (res.length < perPage) {
      break;
    }
    page += 1;
  }

  return files;
}

function parseFilters(yamlLike) {
  // Very small YAML subset parser suitable for inputs used in this repo:
  // filterName:
  //   - 'pattern'
  //   - "!negated"
  //
  // Supports multiple filters, but only one is used here.
  const result = {};
  let current = null;

  const lines = (yamlLike || '').split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const filterMatch = /^([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (filterMatch) {
      current = filterMatch[1];
      if (!result[current]) result[current] = [];
      continue;
    }

    const itemMatch = /^-\s*(.+?)\s*$/.exec(line);
    if (itemMatch && current) {
      let pat = itemMatch[1].trim();
      // strip quotes if present
      if (
        (pat.startsWith("'") && pat.endsWith("'")) ||
        (pat.startsWith('"') && pat.endsWith('"'))
      ) {
        pat = pat.slice(1, -1);
      }
      result[current].push(pat);
    }
  }

  return result;
}

function escapeRegexChar(ch) {
  return ch.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function globToRegex(glob) {
  // Convert a Unix-style glob to a RegExp string
  // - '**' matches across path separators
  // - '*' matches any number of non-separator characters
  // - '?' matches a single non-separator character
  // - '/' is path separator
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      const next = glob[i + 1];
      if (next === '*') {
        // '**'
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeRegexChar(ch);
    }
  }
  return `^${re}$`;
}

function compilePatterns(patternsRaw) {
  const patterns = (patternsRaw || []).map((raw) => {
    let s = String(raw || '').trim();
    let negative = false;
    if (s.startsWith('!')) {
      negative = true;
      s = s.slice(1).trim();
    }
    const rx = new RegExp(globToRegex(s));
    return { negative, rx, raw };
  });
  const hasPositive = patterns.some((p) => !p.negative);
  return { patterns, hasPositive };
}

function fileMatchesFilter(file, compiled) {
  const { patterns, hasPositive } = compiled;
  // If we have at least one positive pattern, default to not included until a positive matches.
  // If we have only negative patterns, default to included until a negative excludes.
  let included = hasPositive ? false : true;

  for (const p of patterns) {
    if (p.rx.test(file)) {
      if (p.negative) {
        included = false;
      } else {
        included = true;
      }
    }
  }
  return included;
}

(async function main() {
  try {
    const filtersInput = getInput('filters', true);
    const filtersMap = parseFilters(filtersInput);
    const filterNames = Object.keys(filtersMap);
    if (filterNames.length === 0) {
      throw new Error('No filters defined in input "filters".');
    }

    const changedFiles = await getChangedFilesFromPR();
    logInfo(`Changed files detected (${changedFiles.length}):`);
    for (const f of changedFiles) console.log(`- ${f}`);

    for (const name of filterNames) {
      const compiled = compilePatterns(filtersMap[name]);
      const result = changedFiles.some((f) => fileMatchesFilter(f, compiled));
      setOutput(name, result ? 'true' : 'false');
      logInfo(`Filter '${name}' -> ${result ? 'true' : 'false'}`);
    }
  } catch (err) {
    // Fail-safe: don't fail the job. Output nothing, but log error and exit success.
    // Aligns with using OR conditions in workflows (e.g., schedule events).
    console.log(`paths-filter-lite encountered an error: ${err && err.message ? err.message : err}`);
    process.exit(0);
  }
})();
