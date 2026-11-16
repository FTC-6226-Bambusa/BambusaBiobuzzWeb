const JAVA_KEYWORDS = new Set([
  'package',
  'import',
  'static',
  'public',
  'private',
  'protected',
  'final',
  'class',
  'extends',
  'return',
  'new',
  'void',
  'while',
  'if',
  'else',
  'null',
  'true',
  'false',
]);

const HIGHLIGHT_CALLS = new Set([
  'enableCommand',
  'takeoutCommand',
  'stop',
  'follow',
  'schedule',
  'sequential',
]);

function stripCommentsAndStringsForScanning(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ' ';
      i++;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += ' ';
          i++;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function normalizePoseFactory(scanSource, rawSource) {
  const match =
    /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?PoseFactory\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^;]+;/m.exec(
      scanSource
    );
  if (!match) {
    return 'private final PoseFactory poseFactory = PoseFactory.degrees();';
  }
  const snippet = rawSource
    .slice(match.index, match.index + match[0].length)
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(public|private|protected)\s+/.test(snippet)) {
    return snippet;
  }
  return `private final ${snippet.replace(/^final\s+/, '')}`;
}

function extractPoses(scanSource, rawSource) {
  const poseRegex =
    /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?Pose\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;]+;/g;
  const poseLines = [];
  const poseNames = [];

  let match;
  while ((match = poseRegex.exec(scanSource)) !== null) {
    poseNames.push(match[1]);
    const rawStatement = rawSource
      .slice(match.index, match.index + match[0].length)
      .replace(/\s+/g, ' ')
      .trim();

    if (/^(public|private|protected)\s+/.test(rawStatement)) {
      poseLines.push(rawStatement);
    } else {
      poseLines.push(`private final ${rawStatement.replace(/^final\s+/, '')}`);
    }
  }

  const startPoseName = poseNames.includes('start')
    ? 'start'
    : poseNames[0] || 'start';

  return { poseLines, startPoseName };
}

function extractPathMethods(scanSource, rawSource, keyword) {
  const methodHeaderRegex =
    /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?Path\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/g;
  const normalizedKeyword = keyword.trim().toLowerCase();
  const paths = [];

  let match;
  while ((match = methodHeaderRegex.exec(scanSource)) !== null) {
    const name = match[1];
    const openBraceIndex = match.index + match[0].length - 1;

    let depth = 0;
    let closeBraceIndex = -1;
    for (let i = openBraceIndex; i < scanSource.length; i++) {
      if (scanSource[i] === '{') {
        depth++;
      } else if (scanSource[i] === '}') {
        depth--;
        if (depth === 0) {
          closeBraceIndex = i;
          break;
        }
      }
    }

    if (closeBraceIndex === -1) {
      continue;
    }

    const rawBody = rawSource.slice(openBraceIndex + 1, closeBraceIndex);
    const bodyLines = rawBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

    const formattedBody =
      bodyLines.length > 0
        ? bodyLines.map((line) => `        ${line}`).join('\n')
        : '        return null;';

    const triggersLaunch =
      normalizedKeyword.length > 0 &&
      name.toLowerCase().includes(normalizedKeyword);

    paths.push({
      name,
      body: formattedBody,
      triggersLaunch,
    });

    methodHeaderRegex.lastIndex = closeBraceIndex + 1;
  }

  return paths;
}

function convertPedroToIvy(rawInput, keyword) {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      poseFactoryLine: 'private final PoseFactory poseFactory = PoseFactory.degrees();',
      poseLines: [],
      startPoseName: 'start',
      paths: [],
      generatedCode: '',
      warnings: [],
    };
  }

  const scanSource = stripCommentsAndStringsForScanning(rawInput);
  const poseFactoryLine = normalizePoseFactory(scanSource, rawInput);
  const { poseLines, startPoseName } = extractPoses(scanSource, rawInput);
  const paths = extractPathMethods(scanSource, rawInput, keyword);

  const warnings = [];
  if (poseLines.length === 0) {
    warnings.push(
      'No Pose declarations detected (for example: private final Pose start = poseFactory.of(x, y, heading);).'
    );
  }
  if (paths.length === 0) {
    warnings.push(
      'No Path methods detected. Paste methods matching "public Path myPath() { return Paths...; }".'
    );
  }

  const routineEntries = [
    '                // Enable both subsystems at start of autonomous',
    '                launcher.enableCommand(),',
    '                conveyor.enableCommand(),',
    '',
  ];

  const commandSteps = [];
  for (const path of paths) {
    commandSteps.push(`follow(follower, ${path.name}())`);
    if (path.triggersLaunch) {
      commandSteps.push('conveyor.takeoutCommand(follower)');
    }
  }

  if (commandSteps.length === 0) {
    routineEntries[2] = '                conveyor.enableCommand()';
    routineEntries.pop();
  } else {
    commandSteps.forEach((step, idx) => {
      const isLast = idx === commandSteps.length - 1;
      const suffix = isLast ? '' : ',';
      if (step === 'conveyor.takeoutCommand(follower)') {
        routineEntries.push('                // Trigger shooting command after launch path');
        routineEntries.push(`                ${step}${suffix}`);
      } else {
        routineEntries.push(`                ${step}${suffix}`);
      }
    });
  }

  const poseBlock =
    poseLines.length > 0
      ? poseLines.map((line) => `    ${line}`).join('\n')
      : '    private final Pose start = poseFactory.of(0, 0, 0);';

  const pathMethodsBlock = paths
    .map((path) => `    public Path ${path.name}() {\n${path.body}\n    }`)
    .join('\n\n');

  const lines = [
    'package org.firstinspires.ftc.teamcode.Bambusa.Autos;',
    '',
    'import com.pedropathing.api.Paths;',
    'import com.pedropathing.api.PoseFactory;',
    'import com.pedropathing.follower.Follower;',
    'import com.pedropathing.math.Pose;',
    'import com.pedropathing.paths.Path;',
    'import com.pedropathing.ivy.Command;',
    'import com.pedropathing.ivy.Scheduler;',
    'import static com.pedropathing.ivy.Scheduler.schedule;',
    'import static com.pedropathing.ivy.groups.Groups.sequential;',
    'import static com.pedropathing.ivy.pedro.PedroCommands.follow;',
    'import com.qualcomm.robotcore.eventloop.opmode.Autonomous;',
    'import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;',
    'import com.pedropathing.paths.interpolator.Interpolator;',
    '',
    'import org.firstinspires.ftc.teamcode.Bambusa.Subsystems.Conveyor;',
    'import org.firstinspires.ftc.teamcode.Bambusa.Subsystems.Launcher;',
    'import org.firstinspires.ftc.teamcode.pedro.Constants;',
    '',
    '@Autonomous(name = "Auto Test")',
    'public class AutoTest extends LinearOpMode {',
    '',
    '    private Follower follower;',
    '',
    `    ${poseFactoryLine}`,
    '',
    poseBlock,
    '',
    '    Launcher launcher;',
    '    Conveyor conveyor;',
    '',
    '    // Autonomous routine scheduled sequentially',
    '    public Command autoRoutine() {',
    '        return sequential(',
    routineEntries.join('\n'),
    '        );',
    '    }',
    '',
    '    @Override',
    '    public void runOpMode() {',
    '        // Initialize subsystems with motors off during init',
    '        launcher = new Launcher(hardwareMap);',
    '        conveyor = new Conveyor(hardwareMap);',
    '',
    '        launcher.init(telemetry);',
    '        conveyor.init(telemetry);',
    '',
    '        // Initialize follower',
    '        follower = Constants.create(hardwareMap);',
    `        follower.setPose(${startPoseName});`,
    '        follower.update();',
    '',
    '        Scheduler.reset();',
    '',
    '        waitForStart();',
    '',
    '        // Schedule full auto command sequence',
    '        schedule(autoRoutine());',
    '',
    '        while (opModeIsActive()) {',
    '            follower.update();',
    '            Scheduler.execute();',
    '',
    '            telemetry.addData("x", follower.pose().x());',
    '            telemetry.addData("y", follower.pose().y());',
    '            telemetry.addData("heading", follower.pose().heading());',
    '',
    '            if (follower.currentPath() != null) {',
    '                telemetry.addData("Current path distance remaining", follower.distanceToEndpoint());',
    '                telemetry.addData("Path number", follower.pathIndex());',
    '            }',
    '',
    '            telemetry.update();',
    '        }',
    '',
    '        // Stop all motors after autonomous period ends',
    '        launcher.stop();',
    '        conveyor.stop();',
    '        Scheduler.reset();',
    '    }',
  ];

  if (pathMethodsBlock) {
    lines.push('');
    lines.push(pathMethodsBlock);
  }
  lines.push('}');

  return {
    poseFactoryLine,
    poseLines,
    startPoseName,
    paths,
    generatedCode: lines.join('\n'),
    warnings,
  };
}

function buildHighlightedLineElement(line) {
  const fragment = document.createDocumentFragment();
  const commentIndex = line.indexOf('//');
  const codePart = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const commentPart = commentIndex >= 0 ? line.slice(commentIndex) : '';

  const tokenRegex =
    /(@[A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

  let lastIndex = 0;
  let match;
  while ((match = tokenRegex.exec(codePart)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(
        document.createTextNode(codePart.slice(lastIndex, match.index))
      );
    }

    const [full, annotation, strLiteral, numLiteral, identifier] = match;
    let tokenClass = '';

    if (annotation) {
      tokenClass = 'tok-ann';
    } else if (strLiteral) {
      tokenClass = 'tok-str';
    } else if (numLiteral) {
      tokenClass = 'tok-num';
    } else if (identifier) {
      if (JAVA_KEYWORDS.has(identifier)) {
        tokenClass = 'tok-kw';
      } else if (HIGHLIGHT_CALLS.has(identifier)) {
        tokenClass = 'tok-call';
      } else if (/^[A-Z]/.test(identifier)) {
        tokenClass = 'tok-type';
      }
    }

    if (tokenClass) {
      const span = document.createElement('span');
      span.className = tokenClass;
      span.textContent = full;
      fragment.appendChild(span);
    } else {
      fragment.appendChild(document.createTextNode(full));
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < codePart.length) {
    fragment.appendChild(document.createTextNode(codePart.slice(lastIndex)));
  }

  if (commentPart) {
    const span = document.createElement('span');
    span.className = 'tok-comment';
    span.textContent = commentPart;
    fragment.appendChild(span);
  }

  if (!fragment.hasChildNodes()) {
    fragment.appendChild(document.createTextNode(' '));
  }

  return fragment;
}

const keywordInput = document.getElementById('launch-keyword');
const coordinatesInput = document.getElementById('pedro-coordinates');
const clearBtn = document.getElementById('clear-btn');
const copyBtnTop = document.getElementById('copy-btn-top');
const copyBtnPanel = document.getElementById('copy-btn-panel');
const sequenceMeta = document.getElementById('sequence-meta');
const sequenceEmpty = document.getElementById('sequence-empty');
const sequenceList = document.getElementById('sequence-list');
const outputMeta = document.getElementById('output-meta');
const warningsBanner = document.getElementById('warnings-banner');
const warningsList = document.getElementById('warnings-list');
const outputEmpty = document.getElementById('output-empty');
const codeViewer = document.getElementById('code-viewer');
const codeTbody = document.getElementById('code-tbody');

let currentGeneratedCode = '';
let copyTimer = null;

function setCopyButtonState(isCopied) {
  const buttons = [
    { el: copyBtnTop, checkClass: 'icon', copyClass: 'icon' },
    { el: copyBtnPanel, checkClass: 'icon-sm text-emerald', copyClass: 'icon-sm' },
  ];

  buttons.forEach(({ el, checkClass, copyClass }) => {
    if (!el) return;
    el.replaceChildren();

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', isCopied ? checkClass : copyClass);

    if (isCopied) {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', 'M20 6 9 17l-5-5');
      svg.appendChild(path);
    } else {
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('width', '14');
      rect.setAttribute('height', '14');
      rect.setAttribute('x', '8');
      rect.setAttribute('y', '8');
      rect.setAttribute('rx', '2');
      rect.setAttribute('ry', '2');
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
      svg.appendChild(rect);
      svg.appendChild(path);
    }

    const label = document.createElement('span');
    label.textContent = isCopied ? 'Copied' : 'Copy Code';
    if (isCopied && el === copyBtnPanel) {
      label.className = 'text-emerald';
    }

    el.appendChild(svg);
    el.appendChild(label);
  });
}

function createSequenceItem(stepNumber, text, roleLabel, launchSubstep, pathMonoName) {
  const li = document.createElement('li');
  li.className = 'sequence-item';

  const row = document.createElement('div');
  row.className = 'sequence-row';

  const left = document.createElement('span');
  left.className = 'sequence-step-text';

  const numSpan = document.createElement('span');
  numSpan.className = 'sequence-step-num tabular-nums';
  numSpan.textContent = String(stepNumber).padStart(2, '0');
  left.appendChild(numSpan);

  if (pathMonoName) {
    left.appendChild(document.createTextNode('Following '));
    const mono = document.createElement('span');
    mono.className = 'font-mono';
    mono.textContent = pathMonoName;
    left.appendChild(mono);
  } else {
    left.appendChild(document.createTextNode(text));
  }

  const role = document.createElement('span');
  role.className = 'sequence-role';
  role.textContent = roleLabel;

  row.appendChild(left);
  row.appendChild(role);
  li.appendChild(row);

  if (launchSubstep) {
    const subRow = document.createElement('div');
    subRow.className = 'sequence-row sequence-row-sub';

    const subText = document.createElement('span');
    subText.className = 'sequence-launch-text';
    subText.textContent = 'Launching Pollen/Nectar';

    const badge = document.createElement('span');
    badge.className = 'sequence-launch-badge';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'icon-sm');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    svg.appendChild(path);

    const badgeLabel = document.createElement('span');
    badgeLabel.textContent = 'Launch';

    badge.appendChild(svg);
    badge.appendChild(badgeLabel);

    subRow.appendChild(subText);
    subRow.appendChild(badge);
    li.appendChild(subRow);
  }

  return li;
}

function render() {
  const rawInput = coordinatesInput.value;
  const keyword = keywordInput.value;
  const hasInput = rawInput.trim().length > 0;
  const result = convertPedroToIvy(rawInput, keyword);

  currentGeneratedCode = result.generatedCode;

  clearBtn.classList.toggle('hidden', !hasInput);
  copyBtnTop.disabled = !currentGeneratedCode;
  copyBtnPanel.disabled = !currentGeneratedCode;

  const launchCount = result.paths.filter((p) => p.triggersLaunch).length;
  sequenceMeta.replaceChildren();
  const pathCountSpan = document.createElement('span');
  pathCountSpan.textContent = `${result.paths.length} paths`;
  const sep = document.createElement('span');
  sep.setAttribute('aria-hidden', 'true');
  sep.className = 'sep';
  sep.textContent = '·';
  const launchCountSpan = document.createElement('span');
  launchCountSpan.textContent = `${launchCount} ${launchCount === 1 ? 'launch trigger' : 'launch triggers'}`;
  sequenceMeta.appendChild(pathCountSpan);
  sequenceMeta.appendChild(sep);
  sequenceMeta.appendChild(launchCountSpan);

  if (!hasInput) {
    sequenceEmpty.classList.remove('hidden');
    sequenceList.classList.add('hidden');
    sequenceList.replaceChildren();

    outputMeta.textContent = 'Waiting for Pedro Pathing input';
    warningsBanner.classList.add('hidden');
    warningsList.replaceChildren();

    outputEmpty.classList.remove('hidden');
    codeViewer.classList.add('hidden');
    codeTbody.replaceChildren();
    return;
  }

  sequenceEmpty.classList.add('hidden');
  sequenceList.classList.remove('hidden');
  sequenceList.replaceChildren();

  sequenceList.appendChild(
    createSequenceItem(1, 'Enabling launcher & enabling conveyor', 'At start', false)
  );
  result.paths.forEach((path, index) => {
    sequenceList.appendChild(
      createSequenceItem(index + 2, '', 'Drive', path.triggersLaunch, path.name)
    );
  });
  sequenceList.appendChild(
    createSequenceItem(
      result.paths.length + 2,
      'Stopping launcher & stopping conveyor',
      'Post-auto',
      false
    )
  );

  const lines = result.generatedCode.split('\n');
  outputMeta.textContent = `${lines.length} lines · Start pose: ${result.startPoseName} · Motors disabled in init & post-loop`;

  if (result.warnings.length > 0) {
    warningsBanner.classList.remove('hidden');
    warningsList.replaceChildren();
    result.warnings.forEach((warning) => {
      const p = document.createElement('p');
      p.textContent = warning;
      warningsList.appendChild(p);
    });
  } else {
    warningsBanner.classList.add('hidden');
    warningsList.replaceChildren();
  }

  outputEmpty.classList.add('hidden');
  codeViewer.classList.remove('hidden');
  codeTbody.replaceChildren();

  const tbodyFragment = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'code-row';

    const numTd = document.createElement('td');
    numTd.className = 'code-line-num tabular-nums';
    numTd.textContent = String(idx + 1);

    const contentTd = document.createElement('td');
    contentTd.className = 'code-line-content';
    contentTd.appendChild(buildHighlightedLineElement(line));

    tr.appendChild(numTd);
    tr.appendChild(contentTd);
    tbodyFragment.appendChild(tr);
  });
  codeTbody.appendChild(tbodyFragment);
}

async function handleCopy() {
  if (!currentGeneratedCode) return;

  try {
    await navigator.clipboard.writeText(currentGeneratedCode);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = currentGeneratedCode;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    document.body.removeChild(helper);
  }

  setCopyButtonState(true);
  if (copyTimer) {
    window.clearTimeout(copyTimer);
  }
  copyTimer = window.setTimeout(() => {
    setCopyButtonState(false);
  }, 1800);
}

keywordInput.addEventListener('input', render);
coordinatesInput.addEventListener('input', render);
clearBtn.addEventListener('click', () => {
  coordinatesInput.value = '';
  setCopyButtonState(false);
  render();
});
copyBtnTop.addEventListener('click', handleCopy);
copyBtnPanel.addEventListener('click', handleCopy);

render();
