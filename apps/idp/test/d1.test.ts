import { describe, expect, it } from 'vitest';
import { createRecordingDatabase, inlineStatement, toSqlLiteral } from '../scripts/d1.js';
import { registerUser, verifyPassword } from '../src/oidc-provider/db/users.js';

describe('toSqlLiteral', () => {
  it('should quote strings and double their single quotes', () => {
    expect(toSqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it('should write numbers and null as they are', () => {
    expect([toSqlLiteral(42), toSqlLiteral(null)]).toEqual(['42', 'NULL']);
  });
});

describe('inlineStatement', () => {
  it('should replace each placeholder with its value in order', () => {
    expect(inlineStatement({ sql: 'SELECT * FROM users WHERE id = ? AND updated_at > ?', params: ['alice', 10] })).toBe(
      "SELECT * FROM users WHERE id = 'alice' AND updated_at > 10",
    );
  });

  it('should reject a statement with fewer params than placeholders', () => {
    expect(() => inlineStatement({ sql: 'SELECT ?, ?', params: [1] })).toThrow('Too few params for: SELECT ?, ?');
  });
});

describe('registerUser through the recording database', () => {
  it('should produce one upsert whose stored hash verifies the password', async () => {
    const { db, statements } = createRecordingDatabase();
    await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true, name: 'Alice', password: 'correct horse battery' });
    expect(statements.length).toBe(1);
    expect(statements[0]!.sql.startsWith('INSERT INTO users (id, email, is_verified, password_hash, created_at, updated_at, claims)')).toBe(true);
    const [id, email, hash, , , claims] = statements[0]!.params;
    expect([id, email, claims]).toEqual(['alice', 'alice@example.com', '{"name":"Alice"}']);
    expect(await verifyPassword('correct horse battery', hash as string)).toBe(true);
    expect(await verifyPassword('wrong', hash as string)).toBe(false);
  });
});
