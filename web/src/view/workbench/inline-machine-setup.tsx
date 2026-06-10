import React from "react";

interface InlineMachineSetupProps {
  children: React.ReactNode;
}

export function InlineMachineSetup(
  { children }: InlineMachineSetupProps,
) {
  return (
    <section className="inline-machine-setup">
      <div className="inline-machine-card">
        <header className="modal-head">
          <div>
            <span>Machine</span>
            <h2>Add machine</h2>
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}
