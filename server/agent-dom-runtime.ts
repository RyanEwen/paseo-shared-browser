import { randomUUID } from "node:crypto";
import {
  DOM_MAX_TEXT,
  DOM_SNAPSHOT_TTL_MS,
  domActionInputSchema,
  domEvaluateInputSchema,
  domSnapshotSchema,
} from "../shared/agent-dom";
import { validateInspectionExpression } from "./agent-dom-expression";
import { type CdpSession, CdpUnknownOutcomeError } from "./cdp";
import type { JsonValue } from "./runtime-protocol";

const COMMAND_MS = 1_500;
const EXECUTION_MS = 1_000;
const MAX_SNAPSHOTS = 16;
interface Receipt {
  page: CdpSession;
  contextId: number;
  inspectionContextId: number;
  generation: string;
  expiresAt: number;
}
interface EvaluationReply {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

/** Private isolated-world references never become selectors or cross-document handles. */
export class AgentDomRuntime {
  private readonly receipts = new Map<string, Receipt>();

  async snapshot(page: CdpSession, generation: string, assertCurrent: () => void) {
    assertCurrent();
    const tree = await page.send<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
      {},
      { timeoutMs: COMMAND_MS },
    );
    assertCurrent();
    const world = await page.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId: tree.frameTree.frame.id,
        worldName: "shared-browser-element-references",
      },
      { timeoutMs: COMMAND_MS },
    );
    assertCurrent();
    const inspectionWorld = await page.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId: tree.frameTree.frame.id,
        worldName: "shared-browser-inspection",
      },
      { timeoutMs: COMMAND_MS },
    );
    assertCurrent();
    const snapshotId = randomUUID();
    const prepared = await page.send<EvaluationReply>(
      "Runtime.evaluate",
      {
        contextId: inspectionWorld.executionContextId,
        expression: `(() => { const documents = globalThis.__sharedBrowserDocuments || (globalThis.__sharedBrowserDocuments = new Map()); documents.set(${JSON.stringify(snapshotId)}, document.documentElement); while (documents.size > 16) documents.delete(documents.keys().next().value); return true; })()`,
        returnByValue: true,
        timeout: EXECUTION_MS,
      },
      { timeoutMs: COMMAND_MS },
    );
    assertCurrent();
    if (prepared.exceptionDetails) throw new Error("Document inspection context unavailable");
    const result = await page.send<EvaluationReply>(
      "Runtime.evaluate",
      {
        contextId: world.executionContextId,
        expression: `(${SNAPSHOT_FUNCTION})(${JSON.stringify(snapshotId)})`,
        timeout: EXECUTION_MS,
        returnByValue: true,
      },
      { timeoutMs: COMMAND_MS },
    );
    assertCurrent();
    if (result.exceptionDetails) throw new Error("DOM snapshot failed; take a fresh snapshot");
    const encoded = JSON.stringify(result.result?.value);
    if (!encoded || encoded.length > DOM_MAX_TEXT)
      throw new Error("DOM snapshot exceeded its output limit");
    const snapshot = domSnapshotSchema.parse(result.result?.value);
    for (const [id, receipt] of this.receipts)
      if (
        receipt.expiresAt <= Date.now() ||
        receipt.page !== page ||
        receipt.generation !== generation
      )
        this.receipts.delete(id);
    this.receipts.set(snapshotId, {
      page,
      generation,
      contextId: world.executionContextId,
      inspectionContextId: inspectionWorld.executionContextId,
      expiresAt: Date.now() + DOM_SNAPSHOT_TTL_MS,
    });
    while (this.receipts.size > MAX_SNAPSHOTS)
      this.receipts.delete(this.receipts.keys().next().value!);
    return snapshot;
  }

  async action(page: CdpSession, generation: string, input: JsonValue, assertCurrent: () => void) {
    const parsed = domActionInputSchema.parse(input);
    const receipt = this.requireReceipt(page, generation, parsed.snapshotId);
    assertCurrent();
    const result = await page.send<EvaluationReply>(
      "Runtime.evaluate",
      {
        contextId: receipt.contextId,
        expression: `(${ACTION_FUNCTION})(${JSON.stringify(parsed.snapshotId)}, ${JSON.stringify(parsed.action)})`,
        timeout: EXECUTION_MS,
        returnByValue: true,
        userGesture: true,
      },
      { mutation: true, timeoutMs: COMMAND_MS },
    );
    // A click may navigate. Never re-resolve or replay it in a replacement document.
    if (result.exceptionDetails)
      throw new CdpUnknownOutcomeError(
        "Element action failed or reference is stale; observe again before any further action",
      );
    if (result.result?.value !== true) throw new Error("Element action was not acknowledged");
    return { acknowledged: true };
  }

  async evaluate(
    page: CdpSession,
    generation: string,
    input: JsonValue,
    assertCurrent: () => void,
  ) {
    const parsed = domEvaluateInputSchema.parse(input);
    const receipt = this.requireReceipt(page, generation, parsed.snapshotId);
    assertCurrent();
    const source = validateInspectionExpression(parsed.expression);
    assertCurrent();
    const expression = `(() => { if (globalThis.__sharedBrowserDocuments?.get(${JSON.stringify(parsed.snapshotId)}) !== document.documentElement) throw new Error('Document replaced'); const value = (\n${source}\n); if (value && typeof value.then === 'function') throw new Error('Async evaluation is unsupported'); const json = JSON.stringify(value); const text = json === undefined ? 'undefined' : json; return { json: text.slice(0, 16000), truncated: text.length > 16000 }; })()`;
    const result = await page.send<EvaluationReply>(
      "Runtime.evaluate",
      {
        contextId: receipt.inspectionContextId,
        expression,
        returnByValue: true,
        throwOnSideEffect: true,
        timeout: EXECUTION_MS,
      },
      { timeoutMs: COMMAND_MS },
    );
    assertCurrent();
    if (result.exceptionDetails)
      throw new Error("Inspection failed, exceeded its time limit, or attempted side effects");
    const value = result.result?.value;
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 17_000)
      throw new Error("Invalid inspection result");
    return value as JsonValue;
  }

  private requireReceipt(page: CdpSession, generation: string, id: string): Receipt {
    const receipt = this.receipts.get(id);
    if (
      !receipt ||
      receipt.page !== page ||
      receipt.generation !== generation ||
      receipt.expiresAt <= Date.now()
    ) {
      this.receipts.delete(id);
      throw new Error("DOM snapshot is stale; take a fresh snapshot in the selected tab");
    }
    return receipt;
  }
}

// Page code runs only in a private world. Work, retained nodes and returned text are all bounded.
// Form values are never read. Editable contents (including passwords) are not used as names.
const SNAPSHOT_FUNCTION = String.raw`function(snapshotId) {
  const snapshots = globalThis.__sharedBrowserReferences || (globalThis.__sharedBrowserReferences = new Map());
  const refs = new Map();
  const entries = [];
  const stack = [{element: document.documentElement, depth: 0}];
  let visited = 0, budget = 0, textBudget = 0, truncated = false;
  const text = (root, max) => {
    let out = '', count = 0;
    const nodes = [root];
    while (nodes.length && count++ < 100 && budget++ < 6000 && out.length < max) {
      const node = nodes.pop();
      if (node.nodeType === 3) out += node.textContent.slice(0, max - out.length) + ' ';
      else if (node.nodeType === 1 && !node.matches('input,textarea,select,[contenteditable],script,style')) {
        for (let i = Math.min(node.childNodes.length, 100) - 1; i >= 0; i--) nodes.push(node.childNodes[i]);
      }
    }
    return out.replace(/\s+/g, ' ').trim().slice(0,max);
  };
  while (stack.length && visited++ < 2000 && entries.length < 200 && textBudget < 18000 && budget < 6000) {
    const {element: el, depth} = stack.pop();
    if (!el || depth > 20) { truncated = true; continue; }
    const style = getComputedStyle(el);
    if (el.hidden || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') continue;
    const editable = el.matches('input,textarea,[contenteditable]');
    const tag = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || ({button:'button',a:el.hasAttribute('href')?'link':'',input:({checkbox:'checkbox',radio:'radio',range:'slider',number:'spinbutton',button:'button',submit:'button',reset:'button',hidden:''})[type] ?? 'textbox',textarea:'textbox',select:el.multiple?'listbox':'combobox',h1:'heading',h2:'heading',h3:'heading',p:'paragraph',label:'label',summary:'button',main:'main',nav:'navigation'})[tag] || (el.isContentEditable?'textbox':'')).slice(0,64);
    if (role && type !== 'hidden') {
      let name = el.getAttribute('aria-label') || '';
      const labelled = el.getAttribute('aria-labelledby');
      if (!name && labelled) name = labelled.split(/\s+/).slice(0,8).map(id=>{const node=document.getElementById(id);return node?text(node,80):''}).join(' ');
      if (!name && el.labels) name = Array.from({length:Math.min(el.labels.length,4)},(_,i)=>text(el.labels[i],80)).join(' ');
      if (!name) name = editable ? (el.getAttribute('placeholder') || '') : text(el,240);
      name = name.slice(0,240);
      if (tag === 'select' && el.options.length > 40) truncated=true;
      const options = tag === 'select' ? Array.from({length:Math.min(el.options.length,40)},(_,i)=>({value:el.options[i].value.slice(0,256),label:text(el.options[i],80)})) : [];
      const entry = {ref:'e'+(entries.length+1),role,name,depth,disabled:!!el.disabled || el.getAttribute('aria-disabled')==='true',sensitive:type==='password',options};
      textBudget += JSON.stringify(entry).length;
      if (textBudget > 18000) {truncated=true;break;}
      entries.push(entry);refs.set(entry.ref,el);
    }
    const children = el.shadowRoot ? el.shadowRoot.children : el.children;
    const remaining = Math.min(children.length, 2000-stack.length);
    if (remaining < children.length) truncated=true;
    for (let i=remaining-1;i>=0;i--) stack.push({element:children[i],depth:depth+1});
  }
  truncated ||= stack.length > 0 || budget >= 6000;
  snapshots.set(snapshotId, {refs, root:document.documentElement, expiresAt:Date.now()+60000});
  for (const [id,s] of snapshots) if (s.expiresAt <= Date.now()) snapshots.delete(id);
  while (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value);
  return {snapshotId,entries,truncated};
}`;

const ACTION_FUNCTION = `function(snapshotId, action) {
  const snapshot = globalThis.__sharedBrowserReferences?.get(snapshotId);
  const el = snapshot?.refs.get(action.ref);
  function assertAvailable() {
    if (!snapshot || snapshot.root !== document.documentElement || snapshot.expiresAt <= Date.now() || !el || !el.isConnected || el.ownerDocument !== document) throw new Error('Stale reference');
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) throw new Error('Element unavailable');
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) throw new Error('Element hidden');
  }
  function activeElement() {
    let active = document.activeElement;
    for (let i=0;i<20;i++) {
      const nested = active?.shadowRoot?.activeElement;
      if (!nested) return active;
      active = nested;
    }
    throw new Error('Focus depth limit');
  }
  function focusTarget(required) {
    let target = el;
    for (let i=0;target && i<20;i++) {
      if (typeof target.focus === 'function' && (target.matches('input:not([type=hidden]),textarea,select,button,a[href],area[href],summary,[tabindex]') || (target.isContentEditable && target.hasAttribute('contenteditable')))) break;
      target = target.parentElement || target.getRootNode().host || null;
      if (i===19 && target) throw new Error('Focus depth limit');
    }
    if (target) {
      target.focus({preventScroll:true});
      // Native focus/blur handlers may detach, disable, replace or redirect the target.
      assertAvailable();
      if (!target.isConnected || activeElement() !== target) throw new Error('Element did not retain focus');
    } else {
      if (required) throw new Error('Element cannot receive focus');
      activeElement()?.blur?.();
      assertAvailable();
    }
  }
  assertAvailable();
  if (action.kind === 'click') {
    if (typeof el.click !== 'function') throw new Error('Not clickable');
    focusTarget(false);
    el.click();
  } else if (action.kind === 'hover') {
    el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,composed:true}));
    el.dispatchEvent(new MouseEvent('mouseenter',{composed:true}));
  } else if (action.kind === 'fill' || action.kind === 'type') {
    if (el.readOnly) throw new Error('Read only');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && ['file','hidden','checkbox','radio','button','submit','reset','range','color'].includes(el.type)) throw new Error('Not a text field');
      const descriptor = Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,'value');
      if (action.kind === 'type' && el.value.length + action.text.length > 4000) throw new Error('Text limit');
      focusTarget(true);
      if (el.readOnly || (el instanceof HTMLInputElement && ['file','hidden','checkbox','radio','button','submit','reset','range','color'].includes(el.type))) throw new Error('Field changed during focus');
      if (action.kind === 'type' && el.value.length + action.text.length > 4000) throw new Error('Text limit');
      descriptor.set.call(el,action.kind === 'type' ? el.value + action.text : action.text);
    } else if (el.isContentEditable) {
      focusTarget(true);
      if (!el.isContentEditable) throw new Error('Field changed during focus');
      if (action.kind === 'type') el.append(document.createTextNode(action.text)); else el.textContent = action.text;
    } else throw new Error('Not editable');
    el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    assertAvailable();
    el.dispatchEvent(new Event('change',{bubbles:true}));
  } else if (action.kind === 'select') {
    function readOptions() {
      if (!(el instanceof HTMLSelectElement) || (!el.multiple && action.values.length !== 1)) throw new Error('Not a matching select');
      if (el.options.length > 1000) throw new Error('Select too large');
      const options = Array.from(el.options);
      if (action.values.some(v=>!options.some(o=>o.value===v && !o.disabled && !o.parentElement?.disabled))) throw new Error('Unknown option');
      return options;
    }
    readOptions();
    focusTarget(true);
    const options = readOptions();
    for (const option of options) option.selected = action.values.includes(option.value);
    el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    assertAvailable();
    el.dispatchEvent(new Event('change',{bubbles:true}));
  } else throw new Error('Unknown action');
  return true;
}`;
