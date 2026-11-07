import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * DL-C-verify4 C4-02: after every await (success and rejection) a manager operation either re-checks its captured
 * intent (`this.stale(…)`) before it writes anything, ends there, or says in one `// intent:` line why it cannot
 * write over a newer intent. A new await without one fails here.
 */
const FILE = join(__dirname, '..', 'manager.ts');

/** Methods exempt as a whole, each with the reason none of its awaits can write over a newer intent. */
const EXEMPT = new Map([
  ['dispose', 'tears the manager down'],
  ['setWifiOnly', 'engine settings only'],
  ['setMaxConcurrent', 'engine settings only'],
  ['settleCleanup', 'cleanup jobs only (records are gone)'],
  ['cleanNow', 'cleanup jobs only (records are gone)'],
  ['availableBytes', 'reads free space'],
  ['pathsReleased', 'reads the engine task'],
  ['volumeMissing', 'reads the volumes'],
  ['fileComplete', 'reads the file size'],
  ['syncSettings', 'engine settings only'],
  ['flushNow', 'the server-delete outbox only'],
  ['takeSnapshot', 'title, artwork and age metadata only'],
  ['checkAccess', 'age verdict metadata only'],
  ['refreshPolicy', 'the profile policy only'],
  ['endTask', 'stops an engine task its caller already decided to end'],
  ['removeNow', 'removing is final: markRemoving bumped the intent and set() never writes over it'],
  ['removeAll', 'removing is final'],
  ['removeMany', 'removing is final'],
  ['removeForSignOut', 'removing is final'],
  ['discardTask', 'the record is gone or removing'],
  ['sweepOrphan', 'an engine task without a record'],
]);

/** Follow-ups that only re-read the store themselves. */
const SAFE_NEXT = /^(return\b|this\.(pump|emit|schedule)\(\);$)/;
const RECHECK = /\bthis\.stale\(|\bthis\.sessionOf\(owner\) !== session/;

type Finding = { method: string; line: number; text: string; where: 'next' | 'catch' };

/** An `// intent:` line before the statement, or before the `if` / `else` whose branch it is. */
function annotated(node: ts.Node, source: ts.SourceFile): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const ranges = ts.getLeadingCommentRanges(source.text, current.getFullStart()) ?? [];
    if (ranges.some((range) => /\/\/ intent: \S/.test(source.text.slice(range.pos, range.end))))
      return true;
    if (!current.parent || !ts.isIfStatement(current.parent)) return false;
  }
  return false;
}

const STATEMENT_KINDS = new Set([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.SwitchStatement,
]);

/** The innermost statement an await sits in (`if (c) await x();` → the `await x();` branch). */
function statementOf(node: ts.Node): ts.Statement {
  let current: ts.Node = node;
  while (current.parent && !STATEMENT_KINDS.has(current.kind)) current = current.parent;
  return current as ts.Statement;
}

const functionOf = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current as ts.FunctionLikeDeclaration | undefined;
};

/** What runs after `statement` in its function: the next statement, climbing out of blocks; null at the end. */
function nextStatement(statement: ts.Statement, fn: ts.Node): ts.Statement | null | 'loop' {
  let current: ts.Node = statement;
  for (;;) {
    const parent = current.parent;
    if (!parent || parent === fn) return null;
    if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      const list = parent.statements;
      const index = list.indexOf(current as ts.Statement);
      if (index >= 0 && index < list.length - 1) return list[index + 1]!;
      if (parent.parent === fn) return null;
    }
    if (ts.isIterationStatement(parent, false)) return 'loop';
    // Leaving a try block: the finally (cleanup only) and then what follows the try statement.
    current = parent;
  }
}

const firstLine = (node: ts.Node, source: ts.SourceFile) =>
  node.getText(source).split('\n')[0]!.trim();

function audit(): Finding[] {
  const source = ts.createSourceFile(
    FILE,
    readFileSync(FILE, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const findings: Finding[] = [];
  const methodName = (fn: ts.Node): string => {
    let current: ts.Node | undefined = fn;
    while (current && !ts.isMethodDeclaration(current)) current = current.parent;
    return current && ts.isMethodDeclaration(current) ? current.name.getText(source) : '?';
  };
  const visit = (node: ts.Node) => {
    if (ts.isAwaitExpression(node)) {
      const fn = functionOf(node);
      const method = fn ? methodName(fn) : '?';
      if (fn && !EXEMPT.has(method)) {
        const statement = statementOf(node);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const plain =
          ts.isExpressionStatement(statement) ||
          ts.isVariableStatement(statement) ||
          ts.isReturnStatement(statement);
        if (!ts.isReturnStatement(statement) && !annotated(statement, source)) {
          const next = plain ? nextStatement(statement, fn) : 'loop';
          const ok =
            next === null ||
            (next !== 'loop' &&
              (RECHECK.test(firstLine(next, source)) || SAFE_NEXT.test(firstLine(next, source))));
          if (!ok)
            findings.push({ method, line, text: firstLine(statement, source), where: 'next' });
        }
      }
    }
    if (ts.isTryStatement(node) && node.catchClause) {
      const fn = functionOf(node);
      const method = fn ? methodName(fn) : '?';
      let awaits = false;
      const scan = (child: ts.Node) => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isAwaitExpression(child)) awaits = true;
        ts.forEachChild(child, scan);
      };
      scan(node.tryBlock);
      const first = node.catchClause.block.statements[0];
      if (awaits && fn && !EXEMPT.has(method) && first) {
        const ok =
          annotated(first, source) ||
          RECHECK.test(firstLine(first, source)) ||
          /^return\b/.test(firstLine(first, source));
        const line =
          source.getLineAndCharacterOfPosition(node.catchClause.getStart(source)).line + 1;
        if (!ok) findings.push({ method, line, text: firstLine(first, source), where: 'catch' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('manager intent audit (C4-02)', () => {
  it('every await is followed by an intent re-check, ends the operation or says why it cannot write', () => {
    const findings = audit();
    expect(findings.map((f) => `${f.method}:${f.line} [${f.where}] ${f.text}`)).toEqual([]);
  });

  it('the exempt methods exist (a rename never widens the exemption silently)', () => {
    const text = readFileSync(FILE, 'utf8');
    for (const name of EXEMPT.keys()) expect(text).toMatch(new RegExp(`\\b${name}\\(`));
  });
});
