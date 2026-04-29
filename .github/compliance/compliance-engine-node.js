// ═══════════════════════════════════════════════════════════════════
// DB COMPLIANCE RULES ENGINE — Node.js / Headless Edition
// Stripped of window/Electron dependencies for CLI and CI use
// ═══════════════════════════════════════════════════════════════════

const ComplianceEngine = (function () {

  const DEFAULT_STANDARDS = {
    version: '1.2',
    title: 'Oracle Database Naming Convention Standards',

    prefixes: {
      table:             { prefix: null,   maxLen: 30, description: 'Tables: UPPERCASE, must be qualified with schema owner' },
      view:              { prefix: 'V_',   maxLen: 30, description: 'Views: must start with V_' },
      materialized_view: { prefix: 'MV_',  maxLen: 30, description: 'Materialized Views: must start with MV_' },
      index:             { prefix: null,   maxLen: 30, description: 'Indexes: must follow {TABLE_NAME}_IX{n}' },
      unique_index:      { prefix: null,   maxLen: 30, description: 'Unique Indexes: must follow {TABLE_NAME}_UI{n}' },
      sequence:          { prefix: 'SEQ_', maxLen: 30, description: 'Sequences: must start with SEQ_' },
      procedure:         { prefix: 'P_',   maxLen: 30, description: 'Procedures: must start with P_' },
      function:          { prefix: 'F_',   maxLen: 30, description: 'Functions: must start with F_' },
      package:           { prefix: 'PKG_', maxLen: 30, description: 'Packages: must start with PKG_' },
      trigger:           { prefix: 'TRG_', maxLen: 30, description: 'Triggers: must start with TRG_' },
      constraint_pk:     { prefix: null, suffix: '_PK', pkMustMatchTable: true, maxLen: 30, description: 'Primary Keys: must be {TABLE_NAME}_PK' },
      constraint_fk:     { prefix: 'FK_',  maxLen: 30, description: 'Foreign Keys: must start with FK_' },
      constraint_uq:     { prefix: 'UQ_',  maxLen: 30, description: 'Unique Constraints: must start with UQ_' },
      constraint_chk:    { prefix: 'CHK_', maxLen: 30, description: 'Check Constraints: must start with CHK_' },
      synonym:           { prefix: 'SYN_', maxLen: 30, description: 'Synonyms: must start with SYN_' },
      type:              { prefix: 'TYP_', maxLen: 30, description: 'Types: must start with TYP_' },
    },

    tablespace: {
      tablesSuffix: '_DTS',
      indexSuffix:  '_ITS',
      description: 'Tablespaces: _DTS for tables, _ITS for indexes'
    },

    columns: {
      description: 'Columns: UPPERCASE, max 30 chars',
      primaryKeySuffix: '_ID',
      foreignKeySuffix: '_ID',
      auditColumns: ['CREATED_BY', 'CREATED_DATE', 'MODIFIED_BY', 'MODIFIED_DATE'],
      reservedWords: ['DATE', 'NUMBER', 'VARCHAR', 'CHAR', 'INTEGER', 'FLOAT', 'BLOB', 'CLOB', 'USER', 'LEVEL', 'ROWID', 'ROWNUM']
    },

    general: {
      noSpaces: true,
      noSpecialChars: true,
      maxIdentifierLength: 30,
      noCamelCase: true,
      useUnderscores: true,
      noLeadingUnderscore: true,
      noTrailingUnderscore: true,
      noDoubleUnderscore: true,
      requireSchemaPrefix: true
    }
  };

  // ─── SQL Parser Helpers ───────────────────────────────────────────────────
  function stripComments(sql) {
    return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  function normalizeSQL(sql) {
    return stripComments(sql).replace(/\s+/g, ' ').trim();
  }

  // ─── Extract Objects from SQL ─────────────────────────────────────────────
  function extractObjects(sql) {
    const objects = [];
    const normalized = normalizeSQL(sql);
    const upper = normalized.toUpperCase();
    let m;

    // CREATE TABLE (capture schema, name, tablespace)
    const tableRe = /CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\s+(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)\s*\(/gi;
    while ((m = tableRe.exec(upper)) !== null) {
      const name = m[2] || m[3];
      const schema = m[1] || null;
      const afterParen = upper.indexOf(')', m.index + m[0].length);
      const tableRest = afterParen > -1 ? upper.slice(afterParen, afterParen + 300) : '';
      const tsTblMatch = tableRest.match(/TABLESPACE\s+(\w+)/i);
      objects.push({ type: 'table', name, schema, tablespace: tsTblMatch ? tsTblMatch[1] : null, raw: m[0], pos: m.index });

      const fromPos = m.index + m[0].length;
      const colBlock = extractParenBlock(normalized, fromPos);
      if (colBlock) {
        const cols = parseColumnDefs(colBlock);
        cols.forEach(col => objects.push({ type: 'column', name: col.name, parent: name, dataType: col.dataType, raw: col.raw, pos: fromPos }));
      }
    }

    // CREATE VIEW
    const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FORCE\s+)?VIEW\s+(?:\w+\.)?(\w+)/gi;
    while ((m = viewRe.exec(upper)) !== null) {
      objects.push({ type: 'view', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE MATERIALIZED VIEW
    const mvRe = /CREATE\s+MATERIALIZED\s+VIEW\s+(?:\w+\.)?(\w+)/gi;
    while ((m = mvRe.exec(upper)) !== null) {
      objects.push({ type: 'materialized_view', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE INDEX (regular) — capture ON table and TABLESPACE
    const idxRe = /CREATE\s+(?:BITMAP\s+)?INDEX\s+(?:\w+\.)?(\w+)\s+ON\s+(?:\w+\.)?(\w+)/gi;
    while ((m = idxRe.exec(upper)) !== null) {
      const idxRest = upper.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const tsMatch = idxRest.match(/TABLESPACE\s+(\w+)/i);
      objects.push({ type: 'index', name: m[1], parent: m[2], tablespace: tsMatch ? tsMatch[1] : null, raw: m[0], pos: m.index });
    }

    // CREATE UNIQUE INDEX
    const uidxRe = /CREATE\s+UNIQUE\s+INDEX\s+(?:\w+\.)?(\w+)\s+ON\s+(?:\w+\.)?(\w+)/gi;
    while ((m = uidxRe.exec(upper)) !== null) {
      const uidxRest = upper.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const tsMatch = uidxRest.match(/TABLESPACE\s+(\w+)/i);
      objects.push({ type: 'unique_index', name: m[1], parent: m[2], tablespace: tsMatch ? tsMatch[1] : null, raw: m[0], pos: m.index });
    }

    // CREATE SEQUENCE
    const seqRe = /CREATE\s+SEQUENCE\s+(?:\w+\.)?(\w+)/gi;
    while ((m = seqRe.exec(upper)) !== null) {
      objects.push({ type: 'sequence', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE PROCEDURE
    const procRe = /CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:\w+\.)?(\w+)/gi;
    while ((m = procRe.exec(upper)) !== null) {
      objects.push({ type: 'procedure', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE FUNCTION
    const funcRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)/gi;
    while ((m = funcRe.exec(upper)) !== null) {
      objects.push({ type: 'function', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE PACKAGE
    const pkgRe = /CREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?(?:\w+\.)?(\w+)/gi;
    while ((m = pkgRe.exec(upper)) !== null) {
      objects.push({ type: 'package', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE TRIGGER
    const trgRe = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:\w+\.)?(\w+)/gi;
    while ((m = trgRe.exec(upper)) !== null) {
      objects.push({ type: 'trigger', name: m[1], raw: m[0], pos: m.index });
    }

    // CREATE SYNONYM
    const synRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:PUBLIC\s+)?SYNONYM\s+(?:\w+\.)?(\w+)/gi;
    while ((m = synRe.exec(upper)) !== null) {
      objects.push({ type: 'synonym', name: m[1], raw: m[0], pos: m.index });
    }

    // CONSTRAINT definitions (inline)
    const pkRe  = /CONSTRAINT\s+(\w+)\s+PRIMARY\s+KEY/gi;
    while ((m = pkRe.exec(upper)) !== null) {
      objects.push({ type: 'constraint_pk', name: m[1], raw: m[0], pos: m.index });
    }
    const fkRe  = /CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY/gi;
    while ((m = fkRe.exec(upper)) !== null) {
      objects.push({ type: 'constraint_fk', name: m[1], raw: m[0], pos: m.index });
    }
    const uqRe  = /CONSTRAINT\s+(\w+)\s+UNIQUE/gi;
    while ((m = uqRe.exec(upper)) !== null) {
      objects.push({ type: 'constraint_uq', name: m[1], raw: m[0], pos: m.index });
    }
    const chkRe = /CONSTRAINT\s+(\w+)\s+CHECK/gi;
    while ((m = chkRe.exec(upper)) !== null) {
      objects.push({ type: 'constraint_chk', name: m[1], raw: m[0], pos: m.index });
    }

    return objects;
  }

  function extractParenBlock(sql, startPos) {
    let depth = 0, start = -1;
    for (let i = startPos; i < sql.length; i++) {
      if (sql[i] === '(') { if (depth === 0) start = i + 1; depth++; }
      else if (sql[i] === ')') { depth--; if (depth === 0) return sql.substring(start, i); }
    }
    return null;
  }

  function parseColumnDefs(block) {
    const cols = [], parts = [];
    let depth = 0, current = '';
    for (const ch of block) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    if (current.trim()) parts.push(current.trim());
    for (const part of parts) {
      const upper = part.toUpperCase().trim();
      if (/^CONSTRAINT\s|^PRIMARY\s+KEY|^FOREIGN\s+KEY|^UNIQUE|^CHECK/.test(upper)) continue;
      const colMatch = upper.match(/^"?([A-Z_][A-Z0-9_]*)"?\s+([A-Z0-9]+)/);
      if (colMatch) cols.push({ name: colMatch[1], dataType: colMatch[2], raw: part });
    }
    return cols;
  }

  // ─── Validate Objects Against Standards ───────────────────────────────────
  function validateObjects(objects, standards, fileName) {
    const violations = [];

    for (const obj of objects) {
      const name = obj.name ? obj.name.toUpperCase() : '';
      const rule = standards.prefixes[obj.type];
      if (!name) continue;

      // Length check
      const maxLen = (rule && rule.maxLen) || standards.general.maxIdentifierLength;
      if (name.length > maxLen) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'NAME_TOO_LONG', severity: 'HIGH',
          description: `"${obj.name}" exceeds max length of ${maxLen} chars (${name.length})`,
          recommendation: `Shorten to ${maxLen} characters or fewer`,
          suggestedFix: `-- Shorten: ${name.substring(0, maxLen)}` });
      }

      // Prefix check
      if (rule && rule.prefix && !name.startsWith(rule.prefix)) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'MISSING_PREFIX', severity: 'HIGH',
          description: `${formatObjectType(obj.type)} "${obj.name}" must start with "${rule.prefix}"`,
          recommendation: rule.description,
          suggestedFix: `-- Rename to: ${rule.prefix}${name}` });
      }

      // Suffix check
      if (rule && rule.suffix && !name.endsWith(rule.suffix)) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'MISSING_SUFFIX', severity: 'HIGH',
          description: `${formatObjectType(obj.type)} "${obj.name}" must end with "${rule.suffix}"`,
          recommendation: rule.description,
          suggestedFix: `-- Rename to: ${name}${rule.suffix}` });
      }

      // PK must match table name
      if (rule && rule.pkMustMatchTable && obj.parent) {
        const expectedPK = obj.parent.toUpperCase() + (rule.suffix || '_PK');
        if (name !== expectedPK) {
          violations.push({ file: fileName, objectType: 'CONSTRAINT PK', objectName: obj.name, parent: obj.parent || '',
            violation: 'PK_NAME_MISMATCH', severity: 'HIGH',
            description: `Primary key "${obj.name}" should be "${expectedPK}" to match table "${obj.parent}"`,
            recommendation: rule.description,
            suggestedFix: `ALTER TABLE ${obj.parent} RENAME CONSTRAINT ${obj.name} TO ${expectedPK};` });
        }
      }

      // No spaces
      if (standards.general.noSpaces && /\s/.test(obj.name)) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'CONTAINS_SPACES', severity: 'CRITICAL',
          description: `"${obj.name}" contains spaces`,
          recommendation: 'Replace spaces with underscores',
          suggestedFix: `RENAME ${obj.name} TO ${obj.name.replace(/\s+/g, '_').toUpperCase()}` });
      }

      // CamelCase
      if (standards.general.noCamelCase && /[a-z][A-Z]/.test(obj.name)) {
        const fixed = obj.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'CAMEL_CASE', severity: 'MEDIUM',
          description: `"${obj.name}" uses camelCase — use UPPER_SNAKE_CASE`,
          recommendation: 'Use uppercase with underscores',
          suggestedFix: `RENAME ${obj.name} TO ${fixed}` });
      }

      // Leading underscore
      if (standards.general.noLeadingUnderscore && name.startsWith('_')) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'LEADING_UNDERSCORE', severity: 'MEDIUM',
          description: `"${obj.name}" starts with underscore`,
          recommendation: 'Remove leading underscore',
          suggestedFix: `RENAME ${obj.name} TO ${name.replace(/^_+/, '')}` });
      }

      // Trailing underscore
      if (standards.general.noTrailingUnderscore && name.endsWith('_')) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'TRAILING_UNDERSCORE', severity: 'MEDIUM',
          description: `"${obj.name}" ends with underscore`,
          recommendation: 'Remove trailing underscore',
          suggestedFix: `RENAME ${obj.name} TO ${name.replace(/_+$/, '')}` });
      }

      // Double underscore
      if (standards.general.noDoubleUnderscore && name.includes('__')) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'DOUBLE_UNDERSCORE', severity: 'LOW',
          description: `"${obj.name}" contains consecutive underscores`,
          recommendation: 'Replace double underscores with single underscore',
          suggestedFix: `RENAME ${obj.name} TO ${name.replace(/__+/g, '_')}` });
      }

      // Reserved word (columns)
      if (obj.type === 'column' && standards.columns.reservedWords.includes(name)) {
        violations.push({ file: fileName, objectType: 'COLUMN', objectName: obj.name, parent: obj.parent || '',
          violation: 'RESERVED_WORD', severity: 'CRITICAL',
          description: `Column "${obj.name}" uses Oracle reserved word`,
          recommendation: `Rename to avoid reserved word "${name}"`,
          suggestedFix: `ALTER TABLE ${obj.parent} RENAME COLUMN ${obj.name} TO ${obj.name}_COL` });
      }

      // Lowercase identifier
      if (obj.type !== 'column' && obj.type !== 'service' && /[a-z]/.test(obj.name)) {
        violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
          violation: 'LOWERCASE_IDENTIFIER', severity: 'MEDIUM',
          description: `"${obj.name}" contains lowercase letters`,
          recommendation: 'Use UPPERCASE for all Oracle object names',
          suggestedFix: `-- Rename to: ${name}` });
      }

      // Rule 1: Tablespace suffix
      if (obj.type === 'table' && obj.tablespace) {
        const ts = obj.tablespace.toUpperCase();
        if (!ts.endsWith('_DTS')) {
          violations.push({ file: fileName, objectType: 'TABLE', objectName: obj.name, parent: obj.parent || '',
            violation: 'TABLESPACE_SUFFIX_INVALID', severity: 'HIGH',
            description: `Table "${obj.name}" tablespace "${obj.tablespace}" must end in _DTS`,
            recommendation: 'Data tablespaces must end with _DTS',
            suggestedFix: `-- Use tablespace: ${ts.replace(/_(DTS|ITS|DATA|IDX)?$/, '')}_DTS` });
        }
      }
      if ((obj.type === 'index' || obj.type === 'unique_index') && obj.tablespace) {
        const ts = obj.tablespace.toUpperCase();
        if (!ts.endsWith('_ITS')) {
          violations.push({ file: fileName, objectType: formatObjectType(obj.type), objectName: obj.name, parent: obj.parent || '',
            violation: 'TABLESPACE_SUFFIX_INVALID', severity: 'HIGH',
            description: `Index "${obj.name}" tablespace "${obj.tablespace}" must end in _ITS`,
            recommendation: 'Index tablespaces must end with _ITS',
            suggestedFix: `-- Use tablespace: ${ts.replace(/_(DTS|ITS|DATA|IDX)?$/, '')}_ITS` });
        }
      }

      // Rule 2: Table must have schema prefix
      if (obj.type === 'table' && standards.general.requireSchemaPrefix && !obj.schema) {
        violations.push({ file: fileName, objectType: 'TABLE', objectName: obj.name, parent: obj.parent || '',
          violation: 'MISSING_SCHEMA_PREFIX', severity: 'HIGH',
          description: `Table "${obj.name}" must be qualified with schema owner (e.g. SCHEMA.${obj.name})`,
          recommendation: 'All tables must include the schema owner prefix',
          suggestedFix: `-- Use: <SCHEMA_OWNER>.${obj.name}` });
      }

      // Rule 3: Index name format {TABLE_NAME}_IX{n}
      if (obj.type === 'index' && obj.parent) {
        const tablePart = obj.parent.toUpperCase();
        if (!new RegExp(`^${tablePart}_IX\\d+$`).test(name)) {
          violations.push({ file: fileName, objectType: 'INDEX', objectName: obj.name, parent: obj.parent || '',
            violation: 'INDEX_NAME_FORMAT', severity: 'HIGH',
            description: `Index "${obj.name}" must follow format ${tablePart}_IX{n} (e.g. ${tablePart}_IX1)`,
            recommendation: 'Index names must be {TABLE_NAME}_IX{n}',
            suggestedFix: `-- Rename to: ${tablePart}_IX1` });
        }
      }

      // Rule 4: Unique index name format {TABLE_NAME}_UI{n}
      if (obj.type === 'unique_index' && obj.parent) {
        const tablePart = obj.parent.toUpperCase();
        if (!new RegExp(`^${tablePart}_UI\\d+$`).test(name)) {
          violations.push({ file: fileName, objectType: 'UNIQUE INDEX', objectName: obj.name, parent: obj.parent || '',
            violation: 'UNIQUE_INDEX_NAME_FORMAT', severity: 'HIGH',
            description: `Unique index "${obj.name}" must follow format ${tablePart}_UI{n} (e.g. ${tablePart}_UI1)`,
            recommendation: 'Unique index names must be {TABLE_NAME}_UI{n}',
            suggestedFix: `-- Rename to: ${tablePart}_UI1` });
        }
      }

    } // end for loop

    return violations;
  }

  function formatObjectType(type) {
    return type.replace(/_/g, ' ').toUpperCase();
  }

  return { DEFAULT_STANDARDS, extractObjects, validateObjects, normalizeSQL };

})();

module.exports = ComplianceEngine;
