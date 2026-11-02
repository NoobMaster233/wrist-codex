ENTRY(bc_file043_anchor)
SECTIONS {
 .text 0 : { *(.text .text.*) }
 .rodata ALIGN(4) : { *(.rodata .rodata.*) }
 .data ALIGN(4) : { *(.data .data.*) }
 .bss ALIGN(4) : { *(.bss .bss.* COMMON) }
 .init_array ALIGN(4) : { KEEP(*(.init_array .init_array.*)) }
 /DISCARD/ : { *(.comment .note.GNU-stack .ARM.exidx* .ARM.extab*) }
}
