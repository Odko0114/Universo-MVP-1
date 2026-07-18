// Anti-bot trap field, shared by both lead forms — see
// lib/validate.js#isBotSubmission on the server for how it's checked.
// Positioned off-screen (not display:none — some bots skip hidden inputs
// entirely) so it's invisible and unreachable by tab for real visitors, but
// still present in the DOM for a bot that blindly fills every input.
export default function Honeypot({ value, onChange }) {
  return (
    <div className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden" aria-hidden="true">
      <label htmlFor="company_website">Leave this field blank</label>
      <input
        id="company_website"
        name="company_website"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
