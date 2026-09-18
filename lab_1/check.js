#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;

// ---------------------------------------------------------------------------
// Conventions registry. Every convention maps to a concrete sentence in
// AGENTS.md or in the "extract-shared-logic-to-common" skill. No other rules
// are invented here.
// ---------------------------------------------------------------------------

const CONVENTIONS = [
  { key: 'api_v1_endpoints',            source: 'AGENTS.md ("All endpoints are under /api/v1")',
    desc: 'All endpoints are under /api/v1.' },
  { key: 'no_lombok',                   source: 'AGENTS.md ("No Lombok")',
    desc: 'No Lombok: no imports, annotations or pom dependency.' },
  { key: 'dto_nested_records',          source: 'AGENTS.md ("DTOs as records")',
    desc: 'request/response DTOs are Java 17 records nested in a domain container class.' },
  { key: 'request_records_validated',   source: 'AGENTS.md ("DTOs as records")',
    desc: 'Use @Valid + Jakarta Bean Validation annotations on request records.' },
  { key: 'valid_on_request_body',       source: 'AGENTS.md ("DTOs as records")',
    desc: '@Valid precedes @RequestBody in controllers.' },
  { key: 'x_user_id_uuid_header',       source: 'AGENTS.md ("DTOs as records")',
    desc: '@RequestHeader("X-User-Id") is typed UUID in controllers; no raw header reads.' },
  { key: 'error_codes_mirror_errorcode',source: 'AGENTS.md ("Error handling")',
    desc: 'IllegalArgumentException codes (string literals) mirror values of common ErrorCode enum.' },
  { key: 'dual_implementation',         source: 'AGENTS.md ("Dual implementation")',
    desc: 'Each domain service: interface *Service + @Primary Jpa*Service + Mock*Service.' },
  { key: 'mock_in_memory_store',        source: 'AGENTS.md ("Dual implementation")',
    desc: 'Mock*Service stores data in-memory with ConcurrentHashMap.' },
  { key: 'mock_tests_mock_clients',     source: 'AGENTS.md ("Testing norms")',
    desc: 'Mock-service unit test (JUnit5) exists for each Mock service; client collaborators are mocked with Mockito.' },
  { key: 'dev_mode_auth_filter',        source: 'AGENTS.md ("Auth")',
    desc: 'DevModeAuthFilter authenticates from the X-User-Id header.' },
  { key: 'security_config_permit_all',  source: 'AGENTS.md ("Auth")',
    desc: 'Internal cross-service endpoints are declared permitAll in the target SecurityConfig.' },
  { key: 'resttemplate_client',         source: 'AGENTS.md ("Modules & ports")',
    desc: 'Cross-service calls use RestTemplate in a client/ class with URLs injected via @Value("${services.<x>-service.url:...}").' },
  { key: 'service_depends_on_common_only', source: 'AGENTS.md ("Modules & ports")',
    desc: 'Every service pom depends on the common module.' },
  { key: 'common_not_standalone_app',   source: 'AGENTS.md ("Modules & ports")',
    desc: 'common is never a standalone app (no main()/@SpringBootApplication).' },
  { key: 'common_no_domain_artifacts',  source: 'skill (sections 2/3)',
    desc: 'common does not declare/import service-domain artifacts (Task/Project/Membership).' },
  { key: 'common_lightweight',          source: 'skill (section 6)',
    desc: 'common stays lightweight: no spring-web / spring-boot-starter-web dependency.' },
  { key: 'no_duplicate_shared_types',   source: 'skill (sections 0/5)',
    desc: 'Identical shared-logic types (DTO/exception/client/utils) are not duplicated across 2+ services.' },
];

const DOMAIN_SERVICES = {
  'user-service': 'AuthService',
  'project-service': 'ProjectService',
  'task-service': 'TaskService',
};

const NOT_CHECKED = [
  'Jpa*Service vs Mock*Service behavioral/logical parity ("keep behavior parallel") - semantic diff, not deterministic.',
  '"Most service getters return null and the controller answers 404" - deliberately fuzzy ("most"/"not all").',
  'Exact-string error mapping to HTTP status in controllers / GlobalExceptionHandler - needs runtime flow analysis.',
  'Adequacy of validation annotation coverage per field (which fields must be @NotBlank etc.) - semantic.',
  'Skill decision about which duplicate copy is canonical before extraction - a design decision.',
  'That tests actually run green and exercise the Mock implementations - requires the Maven build.',
  'Internal cross-service endpoints that are NOT reached via a client/ RestTemplate class - cannot be attributed.',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readText(p) {
  let s = fs.readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function lineNoLb(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function walk(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'target' || e.name === '.git' || e.name === 'node_modules') continue;
      out.push(...walk(p, filter));
    } else if (filter(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function collectJava(modPath) {
  return {
    main: walk(path.join(modPath, 'src', 'main', 'java'), (f) => f.endsWith('.java')),
    test: walk(path.join(modPath, 'src', 'test', 'java'), (f) => f.endsWith('.java')),
  };
}

function javaRel(dir, file) {
  return path.relative(dir, file).replace(/\\/g, '/');
}

function inScope(scope, p) {
  return !scope.files || scope.files.has(path.resolve(p));
}

function touched(scope, mod) {
  return !scope.files || mod.allFiles.some((f) => scope.files.has(path.resolve(f)));
}

function parseErrorCodeCodes(common) {
  const f = common.java.main.find((p) => p.endsWith('ErrorCode.java'));
  if (!f) return { file: null, codes: new Set() };
  const text = readText(f);
  const m = text.match(/enum\s+ErrorCode\s*\{(.*?)\}/s);
  const codes = new Set();
  if (m) {
    for (const part of m[1].split(',')) {
      const c = part.trim().split(/\s/)[0];
      if (c && /^[A-Z][A-Z0-9_]*$/.test(c)) codes.add(c);
    }
  }
  return { file: f, codes };
}

// ---------------------------------------------------------------------------
// Checks. Each returns { convention, file, line, message }[] honoring scope.
// ---------------------------------------------------------------------------

function checkApiV1(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const j = javaRel(mod.javaDir, p);
    if (!j.includes('/controller/')) continue;
    const text = readText(p);
    const lines = text.split('\n');
    const classDeclIdx = lines.findIndex((l) => /^(?:public\s+)?(?:final\s+)?(?:abstract\s+)?class\s+/m.test(l));
    const head = lines.slice(0, classDeclIdx >= 0 ? classDeclIdx : lines.length).join('\n');
    const baseMatch = head.match(/@RequestMapping\s*\(\s*"([^"]+)"/);
    const base = baseMatch ? baseMatch[1] : '';
    const re = /@(?:Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?"([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) {
      const pv = (base ? (base.endsWith('/') ? base.slice(0, -1) : base) : '') + m[1];
      if (pv && pv.startsWith('/') && !pv.startsWith('/api/v1')) {
        out.push({ convention: 'api_v1_endpoints', file: rel(p), line: lineNoLb(text, m.index), message: `effective path "${pv}" is not under /api/v1` });
      }
    }
  }
  return out;
}

const LOMBOK_ANNOTATION = /@(?:Getter|Setter|Data|Builder|AllArgsConstructor|NoArgsConstructor|RequiredArgsConstructor|ToString|EqualsAndHashCode|Slf4j|Accessors)\b/g;

function checkNoLombok(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const text = readText(p);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/import\s+lombok\./.test(lines[i])) {
        out.push({ convention: 'no_lombok', file: rel(p), line: i + 1, message: 'import lombok.*' });
      }
    }
    let m;
    LOMBOK_ANNOTATION.lastIndex = 0;
    while ((m = LOMBOK_ANNOTATION.exec(text))) {
      out.push({ convention: 'no_lombok', file: rel(p), line: lineNoLb(text, m.index), message: `lombok annotation "${m[0]}"` });
    }
  }
  if (mod.pom && inScope(scope, mod.pomPath) && /<artifactId>lombok<\/artifactId>/.test(mod.pom)) {
    out.push({ convention: 'no_lombok', file: rel(mod.pomPath), line: null, message: 'lombok declared as a pom dependency' });
  }
  return out;
}

function checkDtoNestedRecords(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const j = javaRel(mod.javaDir, p);
    if (!j.includes('/dto/')) continue;
    const text = readText(p);
    const lines = text.split('\n');
    let hasNested = false;
    for (let i = 0; i < lines.length; i++) {
      const mn = lines[i].match(/^(\s+)(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?(class|record|interface|enum)\s+(\w+)/);
      if (mn) {
        hasNested = true;
        if (mn[2] !== 'record') {
          out.push({ convention: 'dto_nested_records', file: rel(p), line: i + 1, message: `nested "${mn[3]}" is a ${mn[2]}, request/response DTOs must be records` });
        }
      }
    }
    const top = lines.findIndex((l) => /^(?:public\s+)?(?:final\s+)?class\s+\w+/.test(l));
    if (top >= 0 && !hasNested) {
      const name = lines[top].match(/class\s+(\w+)/)[1];
      if (/(Request|Response|Dto|Error|Data|Info)$/.test(name)) {
        out.push({ convention: 'dto_nested_records', file: rel(p), line: top + 1, message: `top-level DTO class "${name}" is not a record` });
      }
    }
  }
  return out;
}

const VALIDATION_ANNOTATION = /@(?:NotBlank|NotEmpty|NotNull|Email|Size|Pattern|Min|Max|Positive|PositiveOrZero|Negative|NegativeOrZero|Digits|DecimalMin|DecimalMax|Future|FutureOrPresent|Past|PastOrPresent|AssertTrue|AssertFalse|Valid)\b/;

function checkRequestRecordsValidated(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const j = javaRel(mod.javaDir, p);
    if (!j.includes('/dto/')) continue;
    const text = readText(p);
    const recRe = /\brecord\s+(\w*Request)\b/g;
    let m;
    while ((m = recRe.exec(text))) {
      const headerEnd = text.indexOf('{', m.index);
      const header = text.slice(m.index, headerEnd >= 0 ? headerEnd : text.length);
      if (!VALIDATION_ANNOTATION.test(header)) {
        out.push({ convention: 'request_records_validated', file: rel(p), line: lineNoLb(text, m.index), message: `request record "${m[1]}" has no jakarta validation annotations on its components` });
      }
    }
  }
  return out;
}

function checkValidOnRequestBody(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const j = javaRel(mod.javaDir, p);
    if (!j.includes('/controller/')) continue;
    const text = readText(p);
    const re = /@RequestBody\b/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      if (!/@Valid\s*$/.test(before)) {
        out.push({ convention: 'valid_on_request_body', file: rel(p), line: lineNoLb(text, m.index), message: '@RequestBody without @Valid' });
      }
    }
  }
  return out;
}

function checkXUserIdHeader(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const j = javaRel(mod.javaDir, p);
    if (!j.includes('/controller/')) continue;
    const text = readText(p);
    let m;
    const tRe = /@RequestHeader\(\s*(?:value\s*=\s*)?"X-User-Id"\s*\)\s*(?:final\s+)?([A-Za-z]\w*(?:<[^>]+>)?)\s+\w+/g;
    while ((m = tRe.exec(text))) {
      if (m[1] !== 'UUID') {
        out.push({ convention: 'x_user_id_uuid_header', file: rel(p), line: lineNoLb(text, m.index), message: `X-User-Id header typed as "${m[1]}", expected UUID` });
      }
    }
    const hRe = /"X-User-Id"/g;
    while ((m = hRe.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (!/@RequestHeader\(\s*$/.test(before)) {
        out.push({ convention: 'x_user_id_uuid_header', file: rel(p), line: lineNoLb(text, m.index), message: 'raw "X-User-Id" usage outside @RequestHeader' });
      }
    }
  }
  return out;
}

function checkErrorCodes(mod, scope, codes) {
  const out = [];
  const missing = new Map();
  const re = /new\s+IllegalArgumentException\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g;
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const text = readText(p);
    let m;
    while ((m = re.exec(text))) {
      if (codes.has(m[1])) continue;
      if (!missing.has(m[1])) missing.set(m[1], []);
      missing.get(m[1]).push({ file: rel(p), line: lineNoLb(text, m.index) });
    }
  }
  for (const [code, sites] of missing) {
    const loc = sites.map((s) => `${s.file}:${s.line}`).join(', ');
    out.push({ convention: 'error_codes_mirror_errorcode', file: sites[0].file, line: sites[0].line, message: `thrown code "${code}" is not a value of common ErrorCode enum (sites: ${loc})` });
  }
  return out;
}

function checkDualImpl(mod, scope, serviceName) {
  const out = [];
  if (!touched(scope, mod)) return out;
  const jpa = mod.java.main.find((p) => p.endsWith(`Jpa${serviceName}.java`));
  const mock = mod.java.main.find((p) => p.endsWith(`Mock${serviceName}.java`));
  const iface = mod.java.main.find((p) => p.endsWith(`${serviceName}.java`));

  if (!iface) out.push({ convention: 'dual_implementation', file: rel(mod.path), line: null, message: `${serviceName}.java interface is missing` });
  if (!jpa) {
    out.push({ convention: 'dual_implementation', file: rel(mod.path), line: null, message: `Jpa${serviceName}.java is missing` });
  } else {
    const t = readText(jpa);
    if (!/@Primary/.test(t)) { const at = lineNoLb(t, t.indexOf('class Jpa') >= 0 ? t.indexOf('class Jpa') : 0); out.push({ convention: 'dual_implementation', file: rel(jpa), line: at, message: `Jpa${serviceName} is missing @Primary` }); }
    if (!new RegExp(`implements\\s+${serviceName}\\b`).test(t)) out.push({ convention: 'dual_implementation', file: rel(jpa), line: 1, message: `Jpa${serviceName} does not implement ${serviceName}` });
  }
  if (!mock) {
    out.push({ convention: 'dual_implementation', file: rel(mod.path), line: null, message: `Mock${serviceName}.java is missing` });
  } else if (!new RegExp(`implements\\s+${serviceName}\\b`).test(readText(mock))) {
    out.push({ convention: 'dual_implementation', file: rel(mock), line: 1, message: `Mock${serviceName} does not implement ${serviceName}` });
  }
  return out;
}

function checkMockInMemory(mod, scope, serviceName) {
  const out = [];
  const mock = mod.java.main.find((p) => p.endsWith(`Mock${serviceName}.java`));
  if (!mock || !inScope(scope, mock)) return out;
  const t = readText(mock);
  if (!/ConcurrentHashMap/.test(t)) {
    const mm = t.match(/new\s+HashMap\s*[<(]/);
    out.push({ convention: 'mock_in_memory_store', file: rel(mock), line: mm ? lineNoLb(t, mm.index) : 1, message: `Mock${serviceName} does not use an in-memory ConcurrentHashMap store` });
  }
  return out;
}

function checkMockTests(mod, scope, serviceName) {
  const out = [];
  const mock = mod.java.main.find((p) => p.endsWith(`Mock${serviceName}.java`));
  const test = mod.java.test.find((p) => p.endsWith(`Mock${serviceName}Test.java`));
  if (!mock || (!inScope(scope, mock) && !(test && inScope(scope, test)))) return out;

  if (!test) {
    out.push({ convention: 'mock_tests_mock_clients', file: rel(mock), line: 1, message: `Mock${serviceName}Test.java is missing (AGENTS: add a Mock-service unit test for new behavior)` });
    return out;
  }
  const tt = readText(test);
  if (!/import\s+org\.junit\.jupiter/.test(tt) || !/@Test\b/.test(tt)) {
    out.push({ convention: 'mock_tests_mock_clients', file: rel(test), line: 1, message: `Mock${serviceName}Test is not JUnit 5 (@Test)` });
  }
  if (/\b[A-Z]\w*Client\b/.test(readText(mock)) && !/mock\(/.test(tt) && !/Mockito\.mock/.test(tt)) {
    out.push({ convention: 'mock_tests_mock_clients', file: rel(test), line: 1, message: `Mock${serviceName} uses clients but its test does not mock them with Mockito` });
  }
  return out;
}

function checkDevModeAuthFilter(mod, scope) {
  const out = [];
  if (!touched(scope, mod)) return out;
  const f = mod.java.main.find((p) => p.endsWith('DevModeAuthFilter.java'));
  if (!f) {
    out.push({ convention: 'dev_mode_auth_filter', file: rel(mod.path), line: null, message: 'DevModeAuthFilter.java is missing' });
    return out;
  }
  const t = readText(f);
  if (!/X-User-Id/.test(t)) {
    out.push({ convention: 'dev_mode_auth_filter', file: rel(f), line: 1, message: 'DevModeAuthFilter does not reference the X-User-Id header' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client-derived internal endpoints -> must be permitAll in the target
// service's SecurityConfig. Also: SecurityConfig must exist and use
// permitAll() when the module is touched.
// ---------------------------------------------------------------------------

function globToRegex(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else re += /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
  }
  return new RegExp('^' + re + '$');
}

function extractClientPaths(text) {
  const out = [];
  const lines = text.split('\n');
  const tokenRe = /"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*)/g;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('/api/v1')) continue;
    const tokens = [];
    let m;
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(lines[i]))) {
      const lit = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : null;
      tokens.push(lit !== null ? lit : '*');
    }
    const joined = tokens.join('');
    const idx = joined.indexOf('/api/v1');
    if (idx < 0) continue;
    let p = joined.slice(idx).replace(/['"]/g, '').replace(/[\s;·]*$/, '');
    if (p && p.startsWith('/api/v1') && !/["'=<>()]/.test(p)) out.push({ path: p, line: i + 1 });
  }
  return out;
}

function securityPatterns(secText) {
  const out = [];
  const re = /"(\/[^"]*)"/g;
  let m;
  while ((m = re.exec(secText))) out.push(m[1]);
  return out;
}

function checkSecurityConfig(modules, scope) {
  const out = [];
  const byName = new Map(modules.filter((m) => m.kind === 'service').map((m) => [m.name, m]));

  for (const mod of modules) {
    if (mod.kind !== 'service') continue;
    const sec = mod.java.main.find((p) => p.endsWith('SecurityConfig.java'));
    if (touched(scope, mod)) {
      if (!sec) {
        out.push({ convention: 'security_config_permit_all', file: rel(mod.path), line: null, message: 'SecurityConfig.java is missing' });
        continue;
      }
      const t = readText(sec);
      if (!/\.permitAll\s*\(/.test(t)) {
        out.push({ convention: 'security_config_permit_all', file: rel(sec), line: 1, message: 'SecurityConfig has no permitAll() rules' });
      }
    }
  }

  for (const mod of modules) {
    if (mod.kind !== 'service') continue;
    for (const client of mod.java.main) {
      if (!javaRel(mod.javaDir, client).includes('/client/')) continue;
      const text = readText(client);
      const targetMatch = text.match(/services\.([a-z][a-z0-9-]*)-service\.url/);
      if (!targetMatch) continue;
      const target = targetMatch[1] + '-service';
      const targetMod = byName.get(target);
      if (!targetMod) continue;
      const paths = extractClientPaths(text);
      if (paths.length === 0) continue;
      const sec = targetMod.java.main.find((p) => p.endsWith('SecurityConfig.java'));
      if (!sec) continue;
      const matchers = securityPatterns(readText(sec));

      const clientInScope = inScope(scope, client);
      const secInScope = inScope(scope, sec);
      if (scope && !clientInScope && !secInScope) continue;

      for (const entry of paths) {
        const ok = matchers.some((pat) => globToRegex(pat).test(entry.path));
        if (ok) continue;
        const ref = clientInScope ? client : sec;
        out.push({
          convention: 'security_config_permit_all',
          file: rel(ref),
          line: clientInScope ? entry.line : 1,
          message: `internal endpoint "${entry.path}" (called by ${rel(client)}) is not permitAll in ${target} SecurityConfig`,
        });
      }
    }
  }
  return out;
}

function checkRestTemplateClient(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    if (!javaRel(mod.javaDir, p).includes('/client/')) continue;
    const t = readText(p);
    const base = path.basename(p);
    if (!/RestTemplate/.test(t)) {
      out.push({ convention: 'resttemplate_client', file: rel(p), line: 1, message: `${base} does not use RestTemplate` });
    }
    if (!/@Value\(\s*"\$\{services\./.test(t)) {
      out.push({ convention: 'resttemplate_client', file: rel(p), line: 1, message: `${base} has no @Value("\${services...}") URL injection` });
    }
  }
  return out;
}

function checkPomCommonDep(mod, scope) {
  const out = [];
  if (!mod.pom || !inScope(scope, mod.pomPath)) return out;
  const depsMatch = mod.pom.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
  const deps = depsMatch ? depsMatch[1] : '';
  if (!deps) {
    out.push({ convention: 'service_depends_on_common_only', file: rel(mod.pomPath), line: null, message: 'pom has no <dependencies> block' });
  } else if (!/<artifactId>common<\/artifactId>/.test(deps)) {
    out.push({ convention: 'service_depends_on_common_only', file: rel(mod.pomPath), line: null, message: 'pom does not depend on module common' });
  }
  return out;
}

function checkCommonNotStandalone(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const t = readText(p);
    if (t.includes('@SpringBootApplication')) out.push({ convention: 'common_not_standalone_app', file: rel(p), line: 1, message: '@SpringBootApplication present in common' });
    if (/public\s+static\s+void\s+main\s*\(/.test(t)) out.push({ convention: 'common_not_standalone_app', file: rel(p), line: 1, message: 'main() present in common' });
  }
  return out;
}

function checkCommonNoDomainArtifacts(mod, scope) {
  const out = [];
  for (const p of mod.java.main) {
    if (!inScope(scope, p)) continue;
    const t = readText(p);
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const im = lines[i].match(/import\s+(ru\.itmo\.taskmanager\.(?!common)\S+)/);
      if (im) {
        out.push({ convention: 'common_no_domain_artifacts', file: rel(p), line: i + 1, message: `common imports outside itself: ${im[1]}` });
      }
    }
    const dm = t.match(/^[\t ]*(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|record|interface|enum)\s+(\w*(?:Task|Project|Membership)\w*)/m);
    if (dm) {
      out.push({ convention: 'common_no_domain_artifacts', file: rel(p), line: 1, message: `common declares domain-named type "${dm[1]}"` });
    }
  }
  return out;
}

function checkCommonLightweight(mod, scope) {
  const out = [];
  if (!mod.pom || !inScope(scope, mod.pomPath)) return out;
  const dep = mod.pom.match(/<artifactId>(spring-boot-starter-web|spring-web|spring-boot-starter-webflux)<\/artifactId>/);
  if (dep) {
    out.push({ convention: 'common_lightweight', file: rel(mod.pomPath), line: null, message: `skill: common must stay lightweight, but it pulls "${dep[1]}"` });
  }
  return out;
}

function normalizeCode(t) {
  return t
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').trim())
    .filter((l) => l && !l.startsWith('package ') && !l.startsWith('import '))
    .join('\n');
}

function categorySuffix(name) {
  return /(Dto|Request|Response|Exception|Error|Client|Utils|Util|Validation|Permission|Handler)$/.test(name);
}

function checkDuplicateSharedTypes(modules, scope) {
  const out = [];
  const groups = new Map();
  for (const mod of modules) {
    if (mod.kind !== 'service') continue;
    for (const p of mod.java.main) {
      const j = javaRel(mod.javaDir, p);
      const t = readText(p);
      const m = t.match(/^(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|record|interface|enum)\s+(\w+)/m);
      if (!m) continue;
      const name = m[1];
      if (!j.includes('/dto/') && !j.includes('/client/') && !categorySuffix(name)) continue;
      const key = name + '###' + normalizeCode(t);
      if (!groups.has(key)) groups.set(key, { name, occ: [] });
      groups.get(key).occ.push({ module: mod.name, file: rel(p), abs: p });
    }
  }
  for (const g of groups.values()) {
    const mods = [...new Set(g.occ.map((o) => o.module))];
    if (mods.length < 2) continue;
    const inScopeMembers = g.occ.filter((o) => inScope(scope, o.abs));
    if (scope && inScopeMembers.length === 0) continue;
    for (const o of inScopeMembers) {
      out.push({ convention: 'no_duplicate_shared_types', file: o.file, line: 1, message: `identical copy of type "${g.name}" exists in ${mods.length} services [${mods.join(', ')}]; skill: extract shared logic to common` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI / scope resolution
// ---------------------------------------------------------------------------

function printUsage() {
  process.stdout.write(`Usage:
  node check.js                                   audit the whole repo
  node check.js --scope <path>[,<path>...]        audit only the given files/dirs
  node check.js --base <git-ref>                  audit files changed vs <git-ref>
  node check.js --json <report.json>              also write a machine-readable report
  node check.js --help

Scope matters: in a branch experiment the same --scope must be passed on every
branch so that only the files the agent actually changed are measured.
`);
}

function parseArgs(argv) {
  const out = { scopeList: [], base: null, jsonPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { printUsage(); process.exit(0); }
    else if (a === '--scope') out.scopeList.push(...argv[++i].split(',').filter(Boolean));
    else if (a.startsWith('--scope=')) out.scopeList.push(...a.slice(8).split(',').filter(Boolean));
    else if (a === '--base') out.base = argv[++i];
    else if (a.startsWith('--base=')) out.base = a.slice(7);
    else if (a === '--json') out.jsonPath = argv[++i];
    else if (a.startsWith('--json=')) out.jsonPath = a.slice(7);
  }
  return out;
}

function resolveScope(args) {
  if (args.scopeList.length) {
    const files = new Set();
    for (const s of args.scopeList) {
      const abs = path.resolve(ROOT, s);
      if (!fs.existsSync(abs)) continue;
      if (fs.statSync(abs).isDirectory()) {
        for (const f of walk(abs, (name) => name.endsWith('.java') || name.endsWith('.xml'))) files.add(f);
      } else if (abs.endsWith('.java') || path.basename(abs) === 'pom.xml') {
        files.add(abs);
      }
    }
    return { mode: `files (${files.size})`, files };
  }
  if (args.base) {
    let raw = '';
    try {
      raw = execSync(`git -C "${ROOT}" diff --name-only "${args.base}"`, { encoding: 'utf8' });
      raw += execSync(`git -C "${ROOT}" ls-files --others --exclude-standard`, { encoding: 'utf8' });
    } catch (e) {
      throw new Error(`git failed: ${e.message}`);
    }
    const files = new Set();
    for (const line of raw.split('\n')) {
      const rel0 = line.trim();
      if (!rel0) continue;
      const abs = path.resolve(ROOT, rel0);
      if (fs.existsSync(abs) && (abs.endsWith('.java') || path.basename(abs) === 'pom.xml')) files.add(abs);
    }
    return { mode: `git base "${args.base}" (${files.size} files)`, files };
  }
  return { mode: 'all', files: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = resolveScope(args);

  const moduleNames = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(ROOT, d.name, 'pom.xml')))
    .map((d) => d.name);

  const modules = moduleNames.map((n) => {
    const mp = path.join(ROOT, n);
    const kind = n === 'common' ? 'common' : n === 'ui-client' ? 'ui' : n.endsWith('-service') ? 'service' : 'other';
    const java = collectJava(mp);
    const pomPath = path.join(mp, 'pom.xml');
    return {
      name: n,
      kind,
      path: mp,
      javaDir: path.join(mp, 'src', 'main', 'java'),
      java,
      pomPath,
      pom: fs.existsSync(pomPath) ? readText(pomPath) : null,
      allFiles: [...java.main, ...java.test, pomPath].filter((f) => fs.existsSync(f)),
    };
  });

  const common = modules.find((m) => m.kind === 'common');
  const { file: errorCodeFile, codes } = common ? parseErrorCodeCodes(common) : { file: null, codes: new Set() };

  const perModule = [];

  for (const mod of modules) {
    if (mod.kind === 'ui' || mod.kind === 'other') continue;
    const findings = [];
    findings.push(...checkApiV1(mod, scope));
    findings.push(...checkNoLombok(mod, scope));
    findings.push(...checkDtoNestedRecords(mod, scope));
    findings.push(...checkRequestRecordsValidated(mod, scope));
    findings.push(...checkErrorCodes(mod, scope, codes));

    if (mod.kind === 'common') {
      findings.push(...checkCommonNotStandalone(mod, scope));
      findings.push(...checkCommonNoDomainArtifacts(mod, scope));
      findings.push(...checkCommonLightweight(mod, scope));
      perModule.push({ mod, findings });
      continue;
    }

    findings.push(...checkValidOnRequestBody(mod, scope));
    findings.push(...checkXUserIdHeader(mod, scope));

    const domain = DOMAIN_SERVICES[mod.name];
    if (domain) {
      findings.push(...checkDualImpl(mod, scope, domain));
      findings.push(...checkMockInMemory(mod, scope, domain));
      findings.push(...checkMockTests(mod, scope, domain));
    }

    findings.push(...checkDevModeAuthFilter(mod, scope));
    findings.push(...checkRestTemplateClient(mod, scope));
    findings.push(...checkPomCommonDep(mod, scope));

    perModule.push({ mod, findings });
  }

  const securityFindings = checkSecurityConfig(modules, scope);
  const dupFindings = checkDuplicateSharedTypes(modules, scope);
  for (const mod of modules) {
    const entry = perModule.find((e) => e.mod === mod);
    if (!entry) continue;
    entry.findings.push(...securityFindings.filter((f) => f.file.startsWith(`${mod.name}/`)));
    entry.findings.push(...dupFindings.filter((f) => f.file.startsWith(`${mod.name}/`)));
  }

  const lines = [];
  const json = {
    scope: { mode: scope.mode },
    conventions: Object.fromEntries(CONVENTIONS.map((c) => [c.key, { source: c.source, desc: c.desc }])),
    modules: {},
    projectTotalsByConvention: {},
    projectTotal: 0,
    notChecked: NOT_CHECKED,
  };
  let grandTotal = 0;

  lines.push('========================================');
  lines.push(`Scope: ${scope.mode}`);
  lines.push('========================================');

  for (const { mod, findings } of perModule) {
    const label = mod.kind === 'service' ? 'SERVICE' : 'MODULE';
    lines.push(`${label}: ${mod.name}`);

    const counts = {};
    for (const f of findings) counts[f.convention] = (counts[f.convention] || 0) + 1;
    for (const c of CONVENTIONS) {
      const v = counts[c.key] || 0;
      if (v) {
        json.projectTotalsByConvention[c.key] = (json.projectTotalsByConvention[c.key] || 0) + v;
        grandTotal += v;
      }
      lines.push(`  ${c.key}: ${v}`);
    }
    lines.push(`  TOTAL: ${findings.length}`);

    json.modules[mod.name] = { total: findings.length, byConvention: counts, violations: findings };

    if (findings.length) {
      lines.push('  VIOLATIONS:');
      for (const f of findings) {
        const at = f.line ? `:${f.line}` : '';
        lines.push(`    [${f.convention}] ${f.file}${at} - ${f.message}`);
      }
    }
    lines.push('');
  }

  lines.push('========================================');
  lines.push(`PROJECT TOTAL: ${grandTotal}`);
  json.projectTotal = grandTotal;

  lines.push('');
  lines.push('CONVENTIONS CHECKED (deterministic, no LLM):');
  for (const c of CONVENTIONS) lines.push(`  ${c.key} - [${c.source}] ${c.desc}`);
  lines.push('');
  lines.push('CONVENTIONS NOT RELIABLY CHECKABLE WITHOUT LLM:');
  NOT_CHECKED.forEach((n) => lines.push('  - ' + n));
  if (errorCodeFile) lines.push(`(ErrorCode base parsed from ${rel(errorCodeFile)})`);

  process.stdout.write(lines.join('\n') + '\n');

  if (args.jsonPath) {
    fs.writeFileSync(path.resolve(ROOT, args.jsonPath), JSON.stringify(json, null, 2));
    process.stdout.write(`JSON report written to ${args.jsonPath}\n`);
  }
}

try {
  main();
} catch (e) {
  process.stderr.write('check.js error: ' + e.message + '\n');
  process.exit(1);
}