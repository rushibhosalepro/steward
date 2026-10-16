import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setUser } from "./api";
import { Classic } from "./Classic";
import { Welcome } from "./Welcome";
import { Workspace } from "./Workspace";
import "./styles.css";
import "./workspace.css";

// Every visitor works in their own sandbox. "/" is the personal-agent workspace; "/classic"
// keeps the original dashboard.
const classic = window.location.pathname.replace(/\/+$/, "").endsWith("/classic");

function Root() {
  const [state, setState] = useState<"loading" | "welcome" | "ready">("loading");
  useEffect(() => {
    void api.sandbox()
      .then((s) => { if (s.userId) { setUser(s.userId); setState("ready"); } else setState("welcome"); })
      .catch(() => setState("welcome"));
  }, []);
  if (state === "loading") return null;
  if (state === "welcome") return <Welcome onReady={(id) => { setUser(id); setState("ready"); }} />;
  return classic ? <Classic /> : <Workspace onStartOver={() => setState("welcome")} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
