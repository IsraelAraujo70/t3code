import React, { Suspense, useState } from "react";
import { sample, layout, patch, validate } from "./graph";
import "./style.css";
export default function App({ Canvas, name }) {
  const [graph, setGraph] = useState(() => layout(sample));
  const [round, setRound] = useState("pending");
  const [svg, setSvg] = useState("");
  const [show, setShow] = useState(false);
  const readonly = new URLSearchParams(location.search).has("readonly");
  return (
    <div className={readonly ? "readonly" : ""}>
      <header>
        <b>{name}</b>
        {!readonly && <button onClick={() => setGraph(patch(graph))}>Bot patch</button>}
        <button onClick={() => setShow(!show)}>Export SVG</button>
        <span>{round}</span>
      </header>
      <main>
        <article>
          <Suspense fallback="Loading canvas…">
            <Canvas
              graph={graph}
              onChange={setGraph}
              readonly={readonly}
              onRound={setRound}
              onSvg={setSvg}
            />
          </Suspense>
          {show && (
            <div
              className="export"
              dangerouslySetInnerHTML={{ __html: svg || "SVG unavailable" }}
            />
          )}
        </article>
        <aside>
          <b>{round}</b>
          <p>{validate(graph).join("\n") || "Graph valid"}</p>
          <pre>{JSON.stringify(graph, null, 2)}</pre>
        </aside>
      </main>
    </div>
  );
}
