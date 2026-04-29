import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Highlight, themes } from 'prism-react-renderer'

// Markdown is the full-fidelity renderer used in chat-style transcripts.
// Wraps react-markdown with custom renderers — links open in new tabs, code
// blocks get syntax highlighting via prism-react-renderer, prose spacing
// matches Claude Code's terminal output (tight within block, loose between).
//
// For tiny one-line summaries (AgentCard's last_summary box) use
// `renderMiniMarkdown` from utils/miniMarkdown.ts — it's a string→HTML
// regex pass that doesn't pull react-markdown into the per-card render path.

interface MarkdownProps {
  children: string
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, href, children, ...props }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue underline decoration-accent-blue/40 underline-offset-2 hover:decoration-accent-blue break-all"
            {...props}
          >
            {children}
          </a>
        ),
        p: ({ node: _node, children, ...props }) => (
          <p className="my-3 text-[11px] font-mono leading-snug" {...props}>{children}</p>
        ),
        ul: ({ node: _node, children, ...props }) => (
          <ul className="my-3 ml-4 list-disc text-[11px] font-mono space-y-1.5 [&_p]:my-0 [&_p]:text-[11px]" {...props}>{children}</ul>
        ),
        ol: ({ node: _node, children, ...props }) => (
          <ol className="my-3 ml-4 list-decimal text-[11px] font-mono space-y-1.5 [&_p]:my-0 [&_p]:text-[11px]" {...props}>{children}</ol>
        ),
        li: ({ node: _node, children, ...props }) => (
          <li className="text-[11px] font-mono leading-snug" {...props}>{children}</li>
        ),
        h1: ({ node: _node, children, ...props }) => (
          <h2 className="text-white font-bold text-[13px] font-mono mt-4 mb-1.5 leading-tight first:mt-0" {...props}>{children}</h2>
        ),
        h2: ({ node: _node, children, ...props }) => (
          <h3 className="text-white font-bold text-[12px] font-mono mt-4 mb-1.5 leading-tight first:mt-0" {...props}>{children}</h3>
        ),
        h3: ({ node: _node, children, ...props }) => (
          <h4 className="text-white/95 font-semibold text-[11px] font-mono mt-3 mb-1 leading-tight first:mt-0" {...props}>{children}</h4>
        ),
        strong: ({ node: _node, children, ...props }) => (
          <strong className="text-white font-semibold" {...props}>{children}</strong>
        ),
        code: ({ node: _node, className, children, ...props }) => {
          const isBlock = /\n/.test(String(children))
          const langMatch = /language-([\w-]+)/.exec(className || '')
          const lang = langMatch?.[1] || ''
          if (!isBlock) {
            return (
              <code
                className="px-1 py-0.5 rounded bg-white/10 text-accent-yellow text-[11px] font-mono break-words"
                {...props}
              >
                {children}
              </code>
            )
          }
          return <CodeBlock code={String(children).replace(/\n$/, '')} lang={lang} />
        },
        pre: ({ node: _node, children }) => <>{children}</>,
        hr: () => <hr className="border-white/15 my-2" />,
        blockquote: ({ node: _node, children, ...props }) => (
          <blockquote className="border-l-2 border-white/30 pl-2 my-1 text-white/70 italic" {...props}>{children}</blockquote>
        ),
        table: ({ node: _node, children, ...props }) => (
          <div className="my-2 overflow-x-auto rounded border border-white/15">
            <table className="w-full border-collapse text-[11px] font-mono" {...props}>
              {children}
            </table>
          </div>
        ),
        thead: ({ node: _node, children, ...props }) => (
          <thead className="bg-white/8 border-b border-white/20" {...props}>{children}</thead>
        ),
        tbody: ({ node: _node, children, ...props }) => (
          <tbody {...props}>{children}</tbody>
        ),
        tr: ({ node: _node, children, ...props }) => (
          <tr className="border-b border-white/10 last:border-b-0" {...props}>{children}</tr>
        ),
        th: ({ node: _node, children, style: _style, ...props }) => (
          <th className="px-2.5 py-1.5 text-left font-semibold text-white/95 border-r border-white/10 last:border-r-0 align-top" {...props}>
            {children}
          </th>
        ),
        td: ({ node: _node, children, style: _style, ...props }) => (
          <td className="px-2.5 py-1.5 text-white/85 border-r border-white/10 last:border-r-0 align-top" {...props}>
            {children}
          </td>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const language = (lang || 'text') as keyof typeof themes
  return (
    <Highlight code={code} language={language as string} theme={themes.vsDark}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`${className} my-1.5 rounded-md p-2.5 overflow-x-auto text-[11px] font-mono leading-snug`}
          style={{ ...style, background: 'rgba(0,0,0,0.55)' }}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  )
}
