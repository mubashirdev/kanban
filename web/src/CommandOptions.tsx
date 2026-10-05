import { useId, useState } from "react";
import type { ClaudeCommand } from "./api";
import { commandArguments } from "./commandSyntax";
import { Modal } from "./Modal";

export function CommandOptions({ command, initial, onClose, onPrepare, onSend }: {
  command: ClaudeCommand; initial: string; onClose: () => void;
  onPrepare: (text: string) => void; onSend: (text: string) => void;
}) {
  const inputId = useId();
  const { choices, remaining, required } = commandArguments(command);
  const first = initial.split(/\s+/)[0];
  const [choice, setChoice] = useState(choices.includes(first) ? first : "");
  const [args, setArgs] = useState(choices.includes(first) ? initial.slice(first.length).trimStart() : initial);
  const text = [`/${command.name}`, choice, args.trim()].filter(Boolean).join(" ");
  const ready = (!choices.length || !!choice) && (!required || !!args.trim());
  return <Modal title={`/${command.name}`} onClose={onClose}>
    <div className="command-options">
      <p className="muted command-description">{command.description || "Run this command in the ticket’s Claude conversation."}</p>
      {choices.length > 0 && <fieldset className="command-choice-group"><legend>Choose an option</legend>
        <div className="command-choices" role="group" aria-label="Command options">{choices.map((value) => <button type="button" key={value} aria-pressed={choice === value} onClick={() => setChoice(value)}>{value}</button>)}</div>
      </fieldset>}
      <label htmlFor={inputId}>{choices.length ? "Additional arguments" : "Arguments"}{required ? " (required)" : " (optional)"}</label>
      <textarea id={inputId} rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={remaining || "Additional instructions, if needed"} />
      {command.argumentHint && <p className="muted small command-syntax">Usage: /{command.name} {command.argumentHint}</p>}
      <div className="command-preview" aria-label="Command preview"><code>{text}</code></div>
      <p className="muted small">The result will appear in this ticket’s chat. Some commands also change Claude settings or files.</p>
      <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={!ready} onClick={() => onPrepare(text)}>Add to message</button><button type="button" className="btn primary" disabled={!ready} onClick={() => onSend(text)}>Send command</button></div>
    </div>
  </Modal>;
}
