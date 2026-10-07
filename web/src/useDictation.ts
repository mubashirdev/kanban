import { useRef, useState } from "react";

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const Recognizer: (new () => Recognition) | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

export const dictationSupported = !!Recognizer;

/** Speech to text through the browser; each finished phrase goes to onText. Needs HTTPS or localhost. */
export function useDictation(onText: (text: string) => void, onError: (message: string) => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);

  const toggle = () => {
    if (!Recognizer) return;
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const next = new Recognizer();
    next.lang = navigator.language;
    next.continuous = true;
    next.interimResults = false;
    next.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
      }
    };
    next.onerror = (e) => {
      if (e.error === "not-allowed") onError("Microphone access is blocked. Allow it in your browser settings to dictate.");
      else if (e.error !== "no-speech" && e.error !== "aborted") onError(`Dictation stopped: ${e.error}`);
    };
    next.onend = () => setListening(false);
    recognition.current = next;
    next.start();
    setListening(true);
  };

  return { listening, toggle };
}
