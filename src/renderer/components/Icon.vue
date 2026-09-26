<script setup>
import { computed } from 'vue';

const props = defineProps({
    name: { type: String, required: true },
    size: { type: Number, default: 18 }
});

const iconFiles = import.meta.glob('../../../design/UAH_PC_Prototype_v1/assets/icons/*.svg', {
    eager: true,
    query: '?raw',
    import: 'default'
});

const icons = Object.fromEntries(Object.entries(iconFiles).map(([path, source]) => [
    path.split('/').at(-1).replace(/\.svg$/, ''),
    source
]));
const markup = computed(() => icons[props.name] || icons.file);
</script>

<template>
    <span
        class="icon prototype-icon"
        :style="{ '--icon-size': `${size}px` }"
        aria-hidden="true"
        v-html="markup"
    ></span>
</template>
