export function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') node.textContent = String(value ?? '');
    else if (name === 'className') node.className = value;
    else if (name === 'checked' || name === 'disabled' || name === 'multiple' || name === 'open' || name === 'selected') node[name] = Boolean(value);
    else if (name === 'value') node.value = String(value ?? '');
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

export function button(label, onClick, attrs = {}) { return element('button', { type: 'button', ...attrs, text: label, onclick: onClick }); }
export function label(text, control) { const id = control.id || `field-${crypto.randomUUID()}`; control.id = id; return element('label', { for: id }, [text, control]); }
export function optionList(values, selected = '') { return values.map(([value, text]) => element('option', { value, selected: value === selected, text })); }
export function setNotice(root, text, kind = 'info') { root.replaceChildren(element('p', { className: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status', text })); }
