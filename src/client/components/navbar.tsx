import { Button, buttonVariants } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isAdmin, isReadOnlyUser, logOut, pb } from "@/lib/api"
import { cn, runOnce } from "@/lib/utils"
import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
import { getPagePath } from "@nanostores/router"
import { LogOutIcon, MenuIcon, PlusIcon, SearchIcon, ServerIcon, SettingsIcon, UserIcon } from "lucide-react"
import { Suspense, lazy, useState } from "react"
import { LangToggle } from "./lang-toggle"
import { Logo } from "./logo"
import { ModeToggle } from "./mode-toggle"
import { $router, Link, basePath, navigate, prependBasePath } from "./router"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

const CommandPalette = lazy(() => import("./command-palette"))

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0

export default function Navbar() {
	const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)

	const systemTranslation = t`System`

	return (
		<div className="flex items-center h-14 md:h-16 bg-card px-4 pe-3 sm:px-6 border border-border/60 bt-0 rounded-md my-4">
			<Suspense>
				<CommandPalette open={commandPaletteOpen} setOpen={setCommandPaletteOpen} />
			</Suspense>

			<Link
				href={basePath}
				aria-label="Home"
				className="p-2 ps-0 me-3 group"
				onMouseEnter={runOnce(() => import("@/components/routes/home"))}
			>
				<Logo className="h-[1.2rem] md:h-5 fill-foreground" />
			</Link>
			<Button
				variant="outline"
				className="hidden md:block text-sm text-muted-foreground px-4"
				onClick={() => setCommandPaletteOpen(true)}
			>
				<span className="flex items-center">
					<SearchIcon className="me-1.5 h-4 w-4" />
					<Trans>Search</Trans>
					<span className="flex items-center ms-3.5">
						<Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
						<Kbd>K</Kbd>
					</span>
				</span>
			</Button>

			{/* mobile menu */}
			<div className="ms-auto flex items-center text-xl md:hidden">
				<ModeToggle />
				<Button variant="ghost" size="icon" onClick={() => setCommandPaletteOpen(true)}>
					<SearchIcon className="h-[1.2rem] w-[1.2rem]" />
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						onMouseEnter={() => import("@/components/routes/settings/general")}
						className="ms-3"
						aria-label="Open Menu"
					>
						<MenuIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel className="max-w-40 truncate">{pb.authStore.record?.email}</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem
								onClick={() => navigate(getPagePath($router, "settings", { name: "general" }))}
								className="flex items-center"
							>
								<SettingsIcon className="h-4 w-4 me-2.5" />
								<Trans>Settings</Trans>
							</DropdownMenuItem>
							{!isReadOnlyUser() && (
								<DropdownMenuItem
									className="flex items-center"
									onSelect={() => navigate(getPagePath($router, "settings", { name: "general" }))}
								>
									<PlusIcon className="h-4 w-4 me-2.5" />
									<Trans>Add {{ foo: systemTranslation }}</Trans>
								</DropdownMenuItem>
							)}
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem onSelect={logOut} className="flex items-center">
								<LogOutIcon className="h-4 w-4 me-2.5" />
								<Trans>Log Out</Trans>
							</DropdownMenuItem>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* desktop nav */}
			{/** biome-ignore lint/a11y/noStaticElementInteractions: ignore */}
			<div
				className="hidden md:flex items-center ms-auto"
				onMouseEnter={() => import("@/components/routes/settings/general")}
			>
				<LangToggle />
				<ModeToggle />
				<Tooltip>
					<TooltipTrigger asChild>
						<Link
							href={getPagePath($router, "settings", { name: "general" })}
							aria-label="Settings"
							className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
						>
							<SettingsIcon className="h-[1.2rem] w-[1.2rem]" />
						</Link>
					</TooltipTrigger>
					<TooltipContent>
						<Trans>Settings</Trans>
					</TooltipContent>
				</Tooltip>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button aria-label="User Actions" className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}>
							<UserIcon className="h-[1.2rem] w-[1.2rem]" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="center" className="min-w-44">
						<DropdownMenuLabel>{pb.authStore.record?.email}</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{isAdmin() && (
							<>
								<DropdownMenuGroup>
									<DropdownMenuItem asChild>
										<Link href={getPagePath($router, "settings", { name: "general" })}>
											<ServerIcon className="me-2.5 h-4 w-4" />
											<span>
												<Trans>Systems</Trans>
											</span>
										</Link>
									</DropdownMenuItem>
								</DropdownMenuGroup>
								<DropdownMenuSeparator />
							</>
						)}
						<DropdownMenuItem onSelect={logOut}>
							<LogOutIcon className="me-2.5 h-4 w-4" />
							<span>
								<Trans>Log Out</Trans>
							</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	)
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
	<kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
		{children}
	</kbd>
)
