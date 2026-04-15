import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950">
      <SignIn
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "bg-zinc-900 border border-zinc-800 shadow-xl",
            headerTitle: "text-zinc-100",
            headerSubtitle: "text-zinc-400",
            socialButtonsBlockButton:
              "bg-zinc-800 border-zinc-700 text-zinc-100 hover:bg-zinc-700",
            formFieldLabel: "text-zinc-300",
            formFieldInput:
              "bg-zinc-800 border-zinc-700 text-zinc-100 focus:border-blue-500",
            footerActionLink: "text-blue-400 hover:text-blue-300",
            formButtonPrimary:
              "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20",
          },
        }}
      />
    </main>
  );
}
