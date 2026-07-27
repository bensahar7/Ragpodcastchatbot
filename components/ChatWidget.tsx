"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
}

// Empty in this app (same-origin /api/chat). On the podcast site, set
// NEXT_PUBLIC_CHAT_API_URL to the deployed RAG app, e.g.
// https://ragpodcastchatbot.vercel.app
const API_BASE = process.env.NEXT_PUBLIC_CHAT_API_URL ?? "";

export default function ChatWidget() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const data = await res.json();

      if (res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.answer, sources: data.sources },
        ]);
      } else {
        // 400/429 carry a user-facing Hebrew reason (too long, daily cap).
        const reason =
          res.status === 429 || res.status === 400
            ? data.error
            : "שגיאה: לא הצלחתי לעבד את השאלה.";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: reason },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "שגיאה: בעיית תקשורת עם השרת." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      dir="rtl"
      style={{
        maxWidth: 600,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "70vh",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          background: "#1a1a2e",
          color: "white",
          fontWeight: 600,
          fontSize: 16,
        }}
      >
        💬 שאלו על הפודקאסט &quot;איך פותרים את זה?&quot;
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "#fafafa",
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: "#9ca3af", textAlign: "center", marginTop: 40 }}>
            שאלו שאלה על אחד מפרקי הפודקאסט — למשל: &quot;מה הבעיה עם
            דבורים?&quot;
          </p>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                background: msg.role === "user" ? "#1a1a2e" : "white",
                color: msg.role === "user" ? "white" : "#1a1a2e",
                border:
                  msg.role === "assistant" ? "1px solid #e5e7eb" : "none",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {msg.content}
            </div>
            {msg.sources && msg.sources.length > 0 && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: "#6b7280",
                }}
              >
                מקורות: {msg.sources.join(" | ")}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div
            style={{
              alignSelf: "flex-start",
              padding: "10px 14px",
              borderRadius: 12,
              background: "white",
              border: "1px solid #e5e7eb",
              color: "#9ca3af",
            }}
          >
            מחפש תשובה...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: 8,
          padding: 12,
          borderTop: "1px solid #e5e7eb",
          background: "white",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="שאלו שאלה..."
          disabled={loading}
          maxLength={400}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            fontSize: 14,
            outline: "none",
            direction: "rtl",
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: "none",
            background: loading || !input.trim() ? "#d1d5db" : "#1a1a2e",
            color: "white",
            fontWeight: 600,
            cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          שלח
        </button>
      </form>
    </div>
  );
}
