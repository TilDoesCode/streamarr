import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// PLAN §3: no hardcoded UI strings. Every user-visible string comes from src/i18n/locales.
const SRC = join(__dirname, '..');

// Props that render as text or are announced by screen readers.
const TEXT_PROPS = new Set([
  'label',
  'title',
  'subtitle',
  'message',
  'description',
  'placeholder',
  'eyebrow',
  'overview',
  'detail',
  'accessibilityLabel',
  'accessibilityHint',
  'aria-label',
]);

const HAS_WORD = /\p{L}{2,}/u;

const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusToken,
]);

// Literal text an expression can evaluate to: strings, templates, ternary branches, &&/||/?? and + operands.
function literalParts(node: ts.Expression): { node: ts.Node; text: string }[] {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return literalParts(node.expression);
  if (ts.isConditionalExpression(node))
    return [...literalParts(node.whenTrue), ...literalParts(node.whenFalse)];
  if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind))
    return [...literalParts(node.left), ...literalParts(node.right)];
  if (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    HAS_WORD.test(node.text)
  )
    return [{ node, text: node.text }];
  if (
    ts.isTemplateExpression(node) &&
    [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].some((part) =>
      HAS_WORD.test(part)
    )
  )
    return [{ node, text: node.getText() }];
  return [];
}

function propName(name: ts.PropertyName | ts.JsxAttributeName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function findLiteralText(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: string[] = [];
  const report = (expression: ts.Expression) => {
    for (const part of literalParts(expression)) {
      const { line } = file.getLineAndCharacterOfPosition(part.node.getStart());
      found.push(`${fileName}:${line + 1} "${part.text.trim()}"`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && HAS_WORD.test(node.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${fileName}:${line + 1} "${node.text.trim()}"`);
    }
    // Children: {…} directly inside an element or fragment.
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    )
      report(node.expression);
    if (ts.isJsxAttribute(node) && TEXT_PROPS.has(propName(node.name) ?? '') && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init);
      else if (ts.isJsxExpression(init) && init.expression) report(init.expression);
    }
    // Object literals feeding UI: toast.show({ message }), dialog actions, screen options.
    if (ts.isPropertyAssignment(node) && TEXT_PROPS.has(propName(node.name) ?? ''))
      report(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Fixture catalog (film titles, overviews) mirrors Dev World data; it is content, not UI copy.
const CONTENT_FILES = new Set(['screens/gallery/gallery-data.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('no literal UI text', () => {
  it('detects literal text (self-check)', () => {
    const sample = [
      'const a = <Text>Hello world</Text>;',
      "const b = <Text>{'Play now'}</Text>;",
      '<Button label="Resume" />;',
      '<IconButton accessibilityLabel={`Close ${x}`} />;',
      '<Text>{t("ok")} · {count}</Text>;',
      '<Badge label={MEDIA_LABELS.uhd} testID="badge-4k" />;',
      "<Text>{flag ? 'Yes please' : t('no')}</Text>;",
      "<Button label={flag ? t('resume') : 'Start over'} />;",
      "const f = <>{'Fragment literal'}</>;",
      "<Text>{count > 0 && 'Some items'}</Text>;",
      "<Text>{'Hello ' + name}</Text>;",
      "toast.show({ message: 'Saved it', tone: 'success' });",
      "<Stack.Screen options={{ title: 'Gallery' }} />;",
      "const g = { title: t('x'), variant: 'primary', testID: 'some-id' };",
    ].join('\n');
    expect(findLiteralText('sample.tsx', sample)).toEqual([
      'sample.tsx:1 "Hello world"',
      'sample.tsx:2 "Play now"',
      'sample.tsx:3 "Resume"',
      'sample.tsx:4 "`Close ${x}`"',
      'sample.tsx:7 "Yes please"',
      'sample.tsx:8 "Start over"',
      'sample.tsx:9 "Fragment literal"',
      'sample.tsx:10 "Some items"',
      'sample.tsx:11 "Hello"',
      'sample.tsx:12 "Saved it"',
      'sample.tsx:13 "Gallery"',
    ]);
    expect(findLiteralText('hook.ts', "show({ label: 'Plain ts file' });")).toEqual([
      'hook.ts:1 "Plain ts file"',
    ]);
  });

  it('src/**/*.{ts,tsx} renders no hardcoded strings', () => {
    const files = sourceFiles(SRC).filter((path) => !CONTENT_FILES.has(relative(SRC, path)));
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((path) => path.endsWith('.ts'))).toBe(true);
    const violations = files.flatMap((path) =>
      findLiteralText(relative(SRC, path), readFileSync(path, 'utf8'))
    );
    expect(violations).toEqual([]);
  });
});
