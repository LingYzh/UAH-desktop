/** Only visible assistant prose splits consecutive calls; intervening reasoning stays ordered. */
export function activityGroups(activities) {
    const groups = [];
    let reasoning = [];
    const flushReasoning = () => { for (const item of reasoning) groups.push({ id: item.id, tool: false, items: [item] }); reasoning = []; };
    for (const activity of activities) {
        const tool = activity.kind === 'tool' || activity.kind === 'agent';
        const previous = groups.at(-1);
        if (activity.kind === 'reasoning' && previous?.tool) { reasoning.push(activity); continue; }
        if (tool && previous?.tool) { previous.items.push(...reasoning, activity); reasoning = []; }
        else { flushReasoning(); groups.push({ id: activity.id, tool, items: [activity] }); }
    }
    flushReasoning();
    return groups;
}
