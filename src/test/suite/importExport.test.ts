import * as assert from 'assert';
import { ImportExportService } from '../../core/utils/ImportExportService';

suite('ImportExportService Test Suite', () => {
  test('escapeCSVField helper', () => {
    const escape = (ImportExportService as any).escapeCSVField;

    // Normal values
    assert.strictEqual(escape(null), '');
    assert.strictEqual(escape(undefined), '');
    assert.strictEqual(escape('hello'), 'hello');
    assert.strictEqual(escape(123), '123');

    // Values needing escaping
    assert.strictEqual(escape('hello,world'), '"hello,world"');
    assert.strictEqual(escape('hello "world"'), '"hello ""world"""');
    assert.strictEqual(escape('line1\nline2'), '"line1\nline2"');
  });

  test('parseCSV helper basic functionality', () => {
    const parse = (ImportExportService as any).parseCSV;

    const csv1 = 'id,name,role\n1,John Doe,Developer\n2,Jane,Designer';
    const parsed1 = parse(csv1);
    assert.deepStrictEqual(parsed1, [
      ['id', 'name', 'role'],
      ['1', 'John Doe', 'Developer'],
      ['2', 'Jane', 'Designer']
    ]);
  });

  test('parseCSV helper with quotes and commas', () => {
    const parse = (ImportExportService as any).parseCSV;

    const csv2 = 'id,name,bio\n1,"Doe, John","Likes ""coding"" & coffee"\n2,Jane,""';
    const parsed2 = parse(csv2);
    assert.deepStrictEqual(parsed2, [
      ['id', 'name', 'bio'],
      ['1', 'Doe, John', 'Likes "coding" & coffee'],
      ['2', 'Jane', '']
    ]);
  });

  test('parseCSV helper with newlines in fields', () => {
    const parse = (ImportExportService as any).parseCSV;

    const csv3 = 'id,data\n1,"line 1\nline 2"\n2,"normal"';
    const parsed3 = parse(csv3);
    assert.deepStrictEqual(parsed3, [
      ['id', 'data'],
      ['1', 'line 1\nline 2'],
      ['2', 'normal']
    ]);
  });
});
