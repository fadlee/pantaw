#!/usr/bin/env bun
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

function run(cmd: string): string {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
	} catch {
		return ""
	}
}

function parseSemver(v: string) {
	const clean = v.replace(/^v/, "")
	const parts = clean.split(".").map((n) => Number.parseInt(n, 10))
	if (parts.length !== 3 || parts.some(Number.isNaN)) {
		return { major: 0, minor: 0, patch: 1 }
	}
	return { major: parts[0], minor: parts[1], patch: parts[2] }
}

async function main() {
	const rl = createInterface({ input, output })

	console.log("\n🚀 \x1b[1m\x1b[36mPantaw Release & Versioning Helper\x1b[0m\n")

	// 1. Read package.json
	const pkgPath = "./package.json"
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
	const currentPkgVersion = pkg.version || "0.0.1"

	// 2. Read latest git tag
	const latestTag = run("git describe --tags --abbrev=0 2>/dev/null") || ""
	const currentVersion = latestTag ? latestTag.replace(/^v/, "") : currentPkgVersion

	console.log(
		`📌 Current Version: \x1b[33mv${currentVersion}\x1b[0m ${latestTag ? `(from tag ${latestTag})` : "(from package.json)"}`
	)

	// 3. Check uncommitted changes
	const status = run("git status --porcelain")
	if (status) {
		console.log("\n⚠️  \x1b[31mUncommitted changes detected in working directory:\x1b[0m")
		console.log(
			status
				.split("\n")
				.map((line) => `   ${line}`)
				.join("\n")
		)
		const answer = await rl.question("\nDo you want to continue anyway? (y/N): ")
		if (answer.toLowerCase() !== "y") {
			console.log("Release cancelled.")
			rl.close()
			process.exit(0)
		}
	}

	// 4. Show recent commits
	const logRange = latestTag ? `${latestTag}..HEAD` : "-n 10"
	const recentCommits = run(`git log ${logRange} --oneline --no-merges`)
	if (recentCommits) {
		console.log(`\n📝 \x1b[1mCommits since ${latestTag || "start"}:\x1b[0m`)
		console.log(
			recentCommits
				.split("\n")
				.map((line) => `   \x1b[90m${line}\x1b[0m`)
				.join("\n")
		)
	}

	// 5. Suggest next versions
	const { major, minor, patch } = parseSemver(currentVersion)
	const nextPatch = `${major}.${minor}.${patch + 1}`
	const nextMinor = `${major}.${minor + 1}.0`
	const nextMajor = `${major + 1}.0.0`

	console.log("\n💡 \x1b[1mSelect next release version:\x1b[0m")
	console.log(
		`  1) \x1b[32mPatch\x1b[0m   -> v${nextPatch}  \x1b[90m(bugfixes, small tweaks, non-breaking)\x1b[0m`
	)
	console.log(
		`  2) \x1b[34mMinor\x1b[0m   -> v${nextMinor}  \x1b[90m(new features, backward-compatible)\x1b[0m`
	)
	console.log(
		`  3) \x1b[35mMajor\x1b[0m   -> v${nextMajor}  \x1b[90m(breaking changes, big milestones)\x1b[0m`
	)
	console.log("  4) \x1b[33mCustom\x1b[0m  -> enter manually")

	const choice = await rl.question("\nSelect [1-4] (default: 1): ")
	let targetVersion = nextPatch

	if (choice === "2") {
		targetVersion = nextMinor
	} else if (choice === "3") {
		targetVersion = nextMajor
	} else if (choice === "4") {
		const custom = await rl.question("Enter custom version (e.g. 0.2.0): ")
		targetVersion = custom.trim().replace(/^v/, "")
		if (!targetVersion) {
			console.log("Invalid version. Aborting.")
			rl.close()
			process.exit(1)
		}
	}

	const newTag = `v${targetVersion}`
	console.log(`\n🎯 Selected version: \x1b[1m\x1b[32m${newTag}\x1b[0m`)

	// 6. Confirm release
	const confirm = await rl.question(`\nCreate release commit and tag \x1b[32m${newTag}\x1b[0m? (Y/n): `)
	if (confirm.toLowerCase() === "n") {
		console.log("Release cancelled.")
		rl.close()
		process.exit(0)
	}

	// 7. Update package.json, and the CLI's: it ships this release's hub build,
	// so its version has to match the tag (release.yml checks).
	pkg.version = targetVersion
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`)
	const cliPkgPath = "./packages/cli/package.json"
	const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf-8"))
	cliPkg.version = targetVersion
	writeFileSync(cliPkgPath, `${JSON.stringify(cliPkg, null, "\t")}\n`)
	console.log(`✔ Updated package.json and ${cliPkgPath} version to ${targetVersion}`)

	// 8. Git commit & tag
	try {
		execSync(`git add ${pkgPath} ${cliPkgPath}`, { stdio: "inherit" })
		execSync(`git commit -m "chore: release ${newTag}"`, { stdio: "inherit" })
		execSync(`git tag -a ${newTag} -m "Release ${newTag}"`, { stdio: "inherit" })
		console.log(`✔ Created git commit & annotated tag \x1b[32m${newTag}\x1b[0m`)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		console.error("Failed to commit or tag:", msg)
		rl.close()
		process.exit(1)
	}

	// 9. Prompt to push
	console.log("\n📦 \x1b[1mGitHub Actions Auto-Build:\x1b[0m")
	console.log(`Pushing \x1b[32m${newTag}\x1b[0m will automatically trigger GitHub Actions to:`)
	console.log("  • Build & package Hub Worker bundle (SPA static assets + worker + migrations)")
	console.log(`  • Build multi-arch Docker image -> ghcr.io/fadlee/pantaw-agent:latest & :${newTag}`)
	console.log("  • Build cross-platform binaries (Linux, macOS, Windows, FreeBSD)")
	console.log("  • Create GitHub Release with downloadable artifacts & checksums")
	console.log("  • Publish the `pantaw` CLI to npm (bunx pantaw deploy)")

	const pushConfirm = await rl.question("\nPush commit and tag to origin now? (Y/n): ")
	if (pushConfirm.toLowerCase() !== "n") {
		console.log("\nPushing to origin...")
		try {
			execSync("git push", { stdio: "inherit" })
			execSync(`git push origin ${newTag}`, { stdio: "inherit" })
			console.log(`\n🎉 \x1b[1m\x1b[32mSuccessfully pushed ${newTag}!\x1b[0m`)
			console.log("You can monitor the build at: https://github.com/fadlee/pantaw/actions\n")
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			console.error("Failed to push to origin:", msg)
			console.log(`You can manually push later with: git push && git push origin ${newTag}`)
		}
	} else {
		console.log("\nTag created locally. Push when ready:")
		console.log(`  \x1b[36mgit push && git push origin ${newTag}\x1b[0m\n`)
	}

	rl.close()
}

main().catch(console.error)
