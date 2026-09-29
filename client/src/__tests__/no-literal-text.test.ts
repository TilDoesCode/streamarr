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
  // Navigation options and Alert buttons.
  'headerTitle',
  'headerBackTitle',
  'tabBarLabel',
  'tabBarAccessibilityLabel',
  'drawerLabel',
  'text',
]);

// String/array methods whose result still contains the receiver's text.
const TEXT_METHODS = new Set([
  'concat',
  'join',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
]);

// Native dialogs: Alert.alert(title, message, buttons) and Alert.prompt.
const ALERT_METHODS = new Set(['alert', 'prompt']);

const HAS_WORD = /\p{L}{2,}/u;

const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusToken,
]);

type Constants = ReadonlyMap<string, ts.Expression>;

// Literal text an expression can evaluate to (strings, templates, branches, operands, constants, String(), methods, arrays).
function literalParts(
  node: ts.Expression,
  constants: Constants = new Map(),
  seen: ReadonlySet<string> = new Set()
): { node: ts.Node; text: string }[] {
  const parts = (child: ts.Expression) => literalParts(child, constants, seen);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return parts(node.expression);
  if (ts.isConditionalExpression(node)) return [...parts(node.whenTrue), ...parts(node.whenFalse)];
  if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind))
    return [...parts(node.left), ...parts(node.right)];
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((element) => (ts.isExpression(element) ? parts(element) : []));
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text))
    return literalParts(constants.get(node.text)!, constants, new Set([...seen, node.text])).map(
      (part) => ({ node, text: part.text })
    );
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'String' && node.arguments[0])
      return parts(node.arguments[0]);
    // 'Close'.toUpperCase(), ['a', 'b'].join(' ')
    if (ts.isPropertyAccessExpression(callee) && TEXT_METHODS.has(callee.name.text))
      return parts(callee.expression);
    return [];
  }
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
  // Same-file `const NAME = …` bindings, so `label={NAME}` is checked like the literal itself.
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const)
      for (const declaration of node.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const report = (expression: ts.Expression) => {
    for (const part of literalParts(expression, constants)) {
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
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Alert' &&
      ALERT_METHODS.has(node.expression.name.text)
    )
      node.arguments.slice(0, 2).forEach(report);
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
      "const LABEL = 'Play from start';",
      '<Button label={LABEL} />;',
      "Alert.alert('Delete account?', 'This cannot be undone', [{ text: 'Delete' }]);",
      "const o = { headerTitle: 'Settings', tabBarLabel: 'Home' };",
      "<Text>{String('Close window')}</Text>;",
      "<Text>{'Upper'.toUpperCase()}</Text>;",
      "const ICON_SIZE = 'md'; const ROUTE = '/dev/gallery';",
      '<Icon size={ICON_SIZE} testID={ROUTE} />;',
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
      'sample.tsx:16 "Play from start"',
      'sample.tsx:17 "Delete account?"',
      'sample.tsx:17 "This cannot be undone"',
      'sample.tsx:17 "Delete"',
      'sample.tsx:18 "Settings"',
      'sample.tsx:18 "Home"',
      'sample.tsx:19 "Close window"',
      'sample.tsx:20 "Upper"',
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
