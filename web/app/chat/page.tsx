"use client";

/**
 * /chat — Conversational DLF assistant.
 *
 * Users describe what they need in natural language and the agent:
 * 1. Suggests the right template / workflow
 * 2. Calls DLF tools in real-time (list_templates, get_benchmark, etc.)
 * 3. Shows tool results inline
 * 4. Links to the right page
 *
 * Backend: POST /api/chat → SSE stream of {type, content/tool/result}.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";

type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolResult?: string;
};

type StreamEvent = {
  type: "text" | "tool_call" | "tool_result" | "done" | "error";
  content?: string;
  tool?: string;
  args?: string;
  result?: string;
  error?: string;
};

const SUGGESTIONS = [
  "What templates do you have?",
  "I have 50 invoices to extract — what should I do?",
  "How accurate is your parsing?",
  "Can I train a document layout model?",
  "How does the Flywheel game work?",
  "I want to connect my agent via MCP",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || streaming) return;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text.trim(),
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);

    // Build conversation history for API
    const apiMessages = newMessages
      .filter((m) => m.role !== "tool")
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!res.ok || !res.body) {
        setMessages((prev) => [
          ...prev,
          { id: `e-${Date.now()}`, role: "assistant", content: `Error: ${res.status}` },
        ]);
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      let toolMessages: Message[] = [];
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }

          if (event.type === "text" && event.content) {
            assistantText += event.content;
            setMessages((prev) => {
              const without = prev.filter((m) => m.id !== "streaming");
              return [
                ...without,
                ...toolMessages,
                { id: "streaming", role: "assistant", content: assistantText },
              ];
            });
          }

          if (event.type === "tool_call") {
            toolMessages.push({
              id: `tc-${Date.now()}-${event.tool}`,
              role: "tool",
              content: `Calling ${event.tool}...`,
              toolName: event.tool,
            });
            setMessages((prev) => {
              const without = prev.filter((m) => m.id !== "streaming");
              return [...without, ...toolMessages];
            });
          }

          if (event.type === "tool_result") {
            // Update the last tool message with the result
            const last = toolMessages[toolMessages.length - 1];
            if (last) {
              last.content = `${event.tool}: done`;
              last.toolResult = event.result;
            }
            setMessages((prev) => {
              const without = prev.filter(
                (m) => m.id !== "streaming" && !toolMessages.some((tm) => tm.id === m.id),
              );
              return [...without, ...toolMessages];
            });
          }

          if (event.type === "error") {
            assistantText += `\n\n*Error: ${event.error}*`;
          }
        }
      }

      // Finalize
      setMessages((prev) => {
        const without = prev.filter((m) => m.id !== "streaming");
        return [
          ...without,
          ...(assistantText
            ? [{ id: `a-${Date.now()}`, role: "assistant" as const, content: assistantText }]
            : []),
        ];
      });
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: "assistant", content: `Connection error: ${e.message}` },
      ]);
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <div className="hidden md:flex w-64 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="p-4 border-b border-zinc-800">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Data Label Factory
          </Link>
          <p className="text-xs text-zinc-500 mt-1">AI Assistant</p>
        </div>
        <nav className="flex-1 p-4 space-y-1 text-sm">
          <SideLink href="/extract" label="Extract" />
          <SideLink href="/template/library" label="Templates" />
          <SideLink href="/template/new" label="Template Editor" />
          <SideLink href="/parse" label="Parse" />
          <SideLink href="/play/docs" label="Flywheel" />
          <SideLink href="/connect" label="Connect Agent" />
          <SideLink href="/pricing" label="Pricing" />
        </nav>
        <div className="p-4 border-t border-zinc-800 text-xs text-zinc-600">
          Powered by Gemma 4 via OpenRouter
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-semibold">DLF Assistant</h1>
            <p className="text-xs text-zinc-500">Ask about templates, parsing, extraction, or the Flywheel game</p>
          </div>
          <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">
            Back to site
          </Link>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-6 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="text-4xl mb-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600/10 text-blue-400 text-2xl font-bold mx-auto">
                  DLF
                </div>
              </div>
              <h2 className="text-xl font-semibold">What can I help you build?</h2>
              <p className="text-sm text-zinc-400 mt-2 max-w-md">
                Describe the documents you want to process — I&apos;ll find the right template,
                walk you through the workflow, or call DLF tools in real-time.
              </p>
              <div className="mt-8 grid gap-2 sm:grid-cols-2 max-w-lg w-full">
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(s)}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/80 hover:border-zinc-700 px-4 py-3 text-left text-sm text-zinc-300 transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "tool" ? (
                <div className="max-w-xl">
                  <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                    {m.content}
                  </div>
                  {m.toolResult && (
                    <pre className="rounded-lg bg-zinc-900 border border-zinc-800 p-3 text-[11px] text-zinc-400 font-mono max-h-32 overflow-auto">
                      {m.toolResult}
                    </pre>
                  )}
                </div>
              ) : (
                <div
                  className={`rounded-2xl px-4 py-3 max-w-2xl text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-900 border border-zinc-800 text-zinc-200"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <MarkdownLite text={m.content} />
                  ) : (
                    m.content
                  )}
                </div>
              )}
            </div>
          ))}

          {streaming && messages[messages.length - 1]?.role !== "assistant" && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-zinc-900 border border-zinc-800 px-4 py-3">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="h-2 w-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="h-2 w-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-zinc-800 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="flex gap-3 max-w-3xl mx-auto"
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe what you want to extract, or ask about our tools..."
              disabled={streaming}
              className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
              autoFocus
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              className="rounded-xl bg-blue-600 hover:bg-blue-500 px-6 py-3 text-sm font-semibold disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Minimal markdown: **bold**, `code`, [link](url), newlines → <br> */
function MarkdownLite({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\n)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-blue-300">
              {part.slice(1, -1)}
            </code>
          );
        }
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          return (
            <Link key={i} href={linkMatch[2]} className="text-blue-400 underline hover:text-blue-300">
              {linkMatch[1]}
            </Link>
          );
        }
        if (part === "\n") return <br key={i} />;
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function SideLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block rounded-lg px-3 py-2 text-zinc-400 hover:text-white hover:bg-zinc-900 transition"
    >
      {label}
    </Link>
  );
}
