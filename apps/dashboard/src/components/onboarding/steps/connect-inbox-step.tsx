"use client";

import { getInboxEmail } from "@midday/inbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@midday/ui/accordion";
import { motion } from "framer-motion";
import { CopyInput } from "@/components/copy-input";
import { ConnectMailbox } from "@/components/inbox/connect-mailbox";
import { ConnectSlack } from "@/components/inbox/connect-slack";
import { useUserQuery } from "@/hooks/use-user";

export function ConnectInboxStep() {
  const { data: user } = useUserQuery();
  const inboxEmail = getInboxEmail(user?.team?.inboxId ?? "");

  return (
    <div className="space-y-4">
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="text-lg lg:text-xl font-serif"
      >
        Auto-match receipts to transactions
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="text-sm text-muted-foreground leading-relaxed"
      >
        Connect email and we'll find your receipts automatically, as far back as
        you choose, up to a year.
      </motion.p>

      <motion.ul
        className="space-y-2 pl-0 list-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, delay: 0.3 }}
      >
        {[
          "Suggested matches to transactions",
          "Works with Slack and email forwarding",
          "Everything stored and searchable",
        ].map((feature, index) => (
          <motion.li
            key={feature}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: 0.3 + index * 0.1 }}
            className="flex items-start gap-3"
          >
            <div className="relative w-4 h-4 flex items-center justify-center shrink-0 mt-0.5 border border-border bg-secondary">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                className="relative z-10"
              >
                <path
                  d="M2 5L4.5 7.5L8 3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="text-sm text-muted-foreground leading-relaxed">
              {feature}
            </span>
          </motion.li>
        ))}
      </motion.ul>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.6 }}
        className="border-t border-border !mt-6"
      />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.7 }}
        className="!mt-6"
      >
        <ConnectMailbox
          redirectPath="/onboarding?s=connect-inbox"
          className="flex-row space-y-0 gap-2"
        />

        <Accordion type="single" collapsible className="border-t pt-2 mt-4">
          <AccordionItem value="more-options" className="border-0">
            <AccordionTrigger className="justify-center space-x-2 flex text-sm">
              <span>More options</span>
            </AccordionTrigger>
            <AccordionContent className="mt-4">
              <div className="flex flex-col space-y-4">
                <ConnectSlack />
                {inboxEmail && <CopyInput value={inboxEmail} />}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </motion.div>

      <p className="text-[11px] text-muted-foreground text-center pt-4">
        We only scan for receipts · You can disconnect anytime
      </p>
    </div>
  );
}
