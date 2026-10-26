'use strict';
// Checks repository files only. No network requests and no application execution.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function privatePath(file) {
  return /(^|\/)(private-data|local-data|private-screenshots|backups?|exports?|test-results|playwright-report|node_modules)(\/|$)/i.test(file)
    || /(^|\/)\.env(?:\..*)?$/i.test(file) && !/(^|\/)\.env\.example$/i.test(file)
    || /\.(?:pem|key|p12|pfx|sqlite3?|db|sql|xlsx?|docx?|pdf|zip|bak)$/i.test(file)
    || /\.csv$/i.test(file) && !/^tests\/fixtures\/[^/]+\.example\.csv$/i.test(file)
    || /(^|\/)(?:id_rsa|id_ed25519|credentials\.json)$/i.test(file)
    || /(^|\/)(?:prestamo-backup-|diabetes-control-|pulso-rutina-|carpetas-\d{4}-|cuota-respaldo|.*-preguntas\.json|.*-respaldo|.*-backup-)/i.test(file);
}
function allowedJson(file) {
  return /(^|\/)package(?:-lock)?\.json$/.test(file)
    || file === 'ejemplo.json' || file === 'data/tasks.seed.json'
    || /^tests\/fixtures\/[^/]+\.example\.json$/.test(file)
    || /(^|\/)[^/]+\.example\.json$/.test(file);
}
const secretRules = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Stripe live key', /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['Assigned credential', /\b(?:api[_-]?key|password|passwd|client_secret|access_token|secret_key)\b\s*[:=]\s*["'][^"'\r\n]{8,}["']/i],
];
function secretKinds(text) { return secretRules.filter(([, re]) => re.test(text)).map(([kind]) => kind); }
function selfTest() {
  for (const f of ['.env', '.env.local', 'exports/records.json', 'backups/data.json', 'private-data/photo.png', 'secret.key', 'payments.csv', 'cuota-respaldo.json', 'diabetes-control-2026-01-01.json', 'Biologia-preguntas.json']) assert.equal(privatePath(f), true, f);
  for (const f of ['.env.example', 'package-lock.json', 'scripts/check-repository.cjs', 'screenshots/dashboard-mobile.png', 'tests/fixtures/loans.example.csv']) assert.equal(privatePath(f), false, f);
  assert.equal(allowedJson('personal-records.json'), false);
  assert.equal(allowedJson('data/tasks.seed.json'), true);
  assert.equal(allowedJson('tests/fixtures/loans.example.json'), true);
  assert.equal(secretKinds('ghp_' + 'A'.repeat(36)).includes('GitHub token'), true);
  assert.equal(secretKinds('AKIA' + 'A'.repeat(16)).includes('AWS access key'), true);
  assert.equal(secretKinds('-----BEGIN ' + 'PRIVATE KEY-----').includes('Private key'), true);
  assert.equal(secretKinds('password' + ' = "' + 'synthetic-only' + '"').includes('Assigned credential'), true);
  assert.deepEqual(secretKinds('const secretNumber = 1234; const secretaryPercent = 15;'), []);
  console.log('PASS: private paths, JSON allowlist and credential detector self-tests.');
}
function check() {
  const staged = process.argv.includes('--staged');
  const files = execFileSync('git', staged ? ['ls-files', '-z', '--cached'] : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const unique = [...new Set(files)];
  const errors = [];
  let syntaxCount = 0;
  for (const file of unique) {
    if (privatePath(file)) errors.push(`${file}: private data/export/credential path must not be versioned`);
    if (/\.json$/i.test(file) && !allowedJson(file)) errors.push(`${file}: unreviewed JSON; put real data in private-data/, use *.example.json only for synthetic fixtures`);
    const full = path.join(root, file);
    if (!staged && (!fs.existsSync(full) || !fs.statSync(full).isFile())) continue;
    // A partially staged file can differ from disk. The hook must inspect the index.
    let bytes;
    try { bytes = staged ? execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 20 * 1024 * 1024 }) : fs.readFileSync(full); }
    catch { errors.push(`${file}: could not read ${staged ? 'staged' : 'working'} content`); continue; }
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const kind of secretKinds(text)) errors.push(`${file}: possible ${kind} (value withheld)`);
    try {
      if (/\.(?:c?js|mjs)$/.test(file)) {
        execFileSync(process.execPath, ['--check', ...(file.endsWith('.mjs') ? ['--input-type=module'] : [])], { input: text, encoding: 'utf8', stdio: 'pipe' }); syntaxCount++;
      }
      if (/\.json$/.test(file)) JSON.parse(text);
      if (/\.html?$/.test(file)) {
        let block = 0;
        for (const [, attrs, source] of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
          block++;
          if (/\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["'](?:application\/ld\+json|application\/json|importmap)["']/.test(attrs)) continue;
          if (/\btype\s*=\s*["']module["']/.test(attrs)) execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source, stdio: 'pipe' });
          else new vm.Script(source, { filename: `${file}:script-${block}` });
          syntaxCount++;
        }
      }
    } catch { errors.push(`${file}: syntax/JSON validation failed (content withheld; run node --check locally for details)`); }
  }
  const ignored = ['.env', '.env.local', 'private-data/records.json', 'backups/records.json', 'exports/records.json', 'private-screenshots/private.png', 'credentials.json', 'cuota-respaldo.json', 'prestamo-backup-2026-01-01.csv', 'diabetes-control-2026-01-01.json', 'pulso-rutina-2026-01-01.json', 'carpetas-2026-01-01.json', 'Biologia-preguntas.json', 'data/records.csv'];
  for (const file of ignored) {
    try { execFileSync('git', ['check-ignore', '--no-index', '-q', '--', file], { cwd: root, stdio: 'pipe' }); }
    catch { errors.push(`.gitignore does not protect ${file}`); }
  }
  for (const file of ['.env.example', 'package.json', 'tests/fixtures/loans.example.json', 'tests/fixtures/loans.example.csv']) {
    let isIgnored = false;
    try { execFileSync('git', ['check-ignore', '--no-index', '-q', '--', file], { cwd: root, stdio: 'pipe' }); isIgnored = true; }
    catch (error) { if (error.status !== 1) errors.push(`git check-ignore failed for ${file}`); }
    if (isIgnored) errors.push(`.gitignore hides intentional example/config ${file}`);
  }
  if (errors.length) { for (const message of errors) console.error(message); process.exitCode = 1; }
  else console.log(`PASS: ${unique.length} files; privacy paths, credential patterns, ignore rules, JSON and ${syntaxCount} JavaScript blocks checked.`);
}
if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else check();
}
module.exports = { privatePath, allowedJson, secretKinds };
