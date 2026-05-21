import { useState } from "react";

const API = "http://localhost:8080";

export default function App() {
  const [form, setForm] = useState({
    roomNumber: "",
    floor: "",
    roomType: "",
    capacity: "",
  });
  const [status, setStatus] = useState(null);

  function update(field) {
    return (e) => setForm({ ...form, [field]: e.target.value });
  }

  async function submit(e) {
    e.preventDefault();
    setStatus({ kind: "submitting" });
    try {
      const res = await fetch(`${API}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomNumber: Number(form.roomNumber),
          floor: Number(form.floor),
          roomType: form.roomType,
          capacity: Number(form.capacity),
        }),
      });
      if (res.ok) {
        setStatus({ kind: "ok" });
        setForm({ roomNumber: "", floor: "", roomType: "", capacity: "" });
      } else {
        const text = await res.text();
        setStatus({ kind: "error", message: text || res.statusText });
      }
    } catch (err) {
      setStatus({ kind: "error", message: err.message });
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 480 }}>
      <h1>Room Management</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          Room number
          <input
            type="number"
            required
            value={form.roomNumber}
            onChange={update("roomNumber")}
          />
        </label>
        <label>
          Floor
          <input
            type="number"
            required
            value={form.floor}
            onChange={update("floor")}
          />
        </label>
        <label>
          Room type
          <input
            type="text"
            required
            value={form.roomType}
            onChange={update("roomType")}
          />
        </label>
        <label>
          Capacity
          <input
            type="number"
            required
            value={form.capacity}
            onChange={update("capacity")}
          />
        </label>
        <button type="submit" disabled={status?.kind === "submitting"}>
          Add room
        </button>
      </form>
      {status?.kind === "ok" && <p style={{ color: "green" }}>Room added.</p>}
      {status?.kind === "error" && (
        <p style={{ color: "crimson" }}>Error: {status.message}</p>
      )}
    </main>
  );
}
