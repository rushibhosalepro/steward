import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Classic } from "./Classic";
import { Workspace } from "./Workspace";
import "./styles.css";
import "./workspace.css";

// "/" is the personal-agent workspace; "/classic" keeps the original dashboard.
const classic = window.location.pathname.replace(/\/+$/, "").endsWith("/classic");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {classic ? <Classic /> : <Workspace />}
  </StrictMode>,
);
