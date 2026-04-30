import { App, FuzzySuggestModal, TFolder } from "obsidian";

/**
 * Modal that lets the user pick an existing vault folder. We deliberately
 * only show *real* folders so callers can't accidentally type a path that
 * doesn't exist. For the "create a brand new folder" flow we present a
 * different, free-text input elsewhere.
 */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly onChoose: (folder: TFolder) => void,
		private readonly opts: {
			title?: string;
			emptyText?: string;
			filter?: (folder: TFolder) => boolean;
		} = {}
	) {
		super(app);
		this.setPlaceholder(opts.title ?? "Select a folder…");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const walk = (folder: TFolder): void => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
			}
		};
		walk(this.app.vault.getRoot());
		const filter = this.opts.filter;
		const filtered = filter ? folders.filter(filter) : folders;
		return filtered.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path === "" ? "/" : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}
