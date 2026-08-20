# -*- coding: utf-8 -*-
"""
Created on Mon Nov 10 09:47:55 2025

@author: 15hal
"""

import numpy as np
import scipy
import matplotlib.pyplot as plt

# Test basic math
x = np.linspace(0, 10, 100)
y = np.sin(x)

plt.plot(x, y)
plt.title("First test plot")
plt.xlabel("x")
plt.ylabel("sin(x)")
plt.show()

print("Everything works!")
