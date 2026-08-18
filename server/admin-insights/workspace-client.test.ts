import { describe, expect, it } from 'vitest';
import { quoteSqlIdent, quoteSqlLiteral } from './workspace-client';

describe('SQL quoting for Unity Catalog tag actions', () => {
  it('quotes dotted identifiers', () => {
    expect(quoteSqlIdent('demos.admin_insights')).toBe('`demos`.`admin_insights`');
  });

  it('escapes string literals', () => {
    expect(quoteSqlLiteral("O'Reilly")).toBe("'O''Reilly'");
  });
});
